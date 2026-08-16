/**
 * Recovery sweeper for stranded crawls — the durable backstop for an interruption AFTER the engine staged
 * its extraction but BEFORE runCrawl folded the outcome into the connection's bookkeeping.
 *
 * runCrawl's happy path is: stage → storeCrawlResults → applyCrawl* (which flips the connection OFF
 * 'syncing') → markSessionTerminal. If the process dies (or the session is marked terminal by the engine
 * telemetry / the reaper) between staging and the bookkeeping, the staged_records are stranded and the
 * connection is stuck 'syncing' forever. This sweeper — invoked from schedulerTick, decoupled from the
 * dispatch call — finds exactly those sessions (terminal status, owning connection still 'syncing') and
 * completes the promotion IDEMPOTENTLY: storeCrawlResults reuses the session's persisted authoritative
 * update targets and each staged observation's durable occurrence claim, and applyCrawl* simply re-counts
 * the connection out of 'syncing'.
 *
 * A 'completed' session is re-promoted (store + applyCrawlSuccess); a 'failed' session has no trustworthy
 * extraction to store, so it is only reconciled (applyCrawlFailure) so the connection leaves 'syncing' and
 * the failure is counted toward escalation.
 */
import { aliasedTable, and, eq, exists, inArray, lt, notExists, or, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections, sessionEvents, sessions, stagedRecords } from '../db/schema';
import { ACTIVE_SESSION_STATUSES, markSessionTerminal } from '../data/sessions';
import { stagedTransactionForStore, storeCrawlResults } from '../data/store-crawl';
import { applyCrawlSuccess, applyCrawlFailure } from '../data/crawl-bookkeeping';

export interface RecoverStrandedResult {
  recovered: number;
}

/**
 * Reconcile sessions that reached a terminal status while their connection is still 'syncing' (the
 * bookkeeping never ran). Returns how many were recovered. `now`/per-call options stay injectable for tests.
 */
export async function recoverStrandedCrawls(db: Db, now: Date = new Date()): Promise<RecoverStrandedResult> {
  // Candidate list: terminal sessions whose connection is still mid-sync AND has no in-flight session.
  // The active-session guard is what makes this safe to re-run: once a NEW crawl starts it holds an active
  // session and owns the connection's 'syncing' state, so we must not re-promote an OLD terminal session's
  // stale staged_records into that live sync. Only a connection that is 'syncing' with NO active session is
  // genuinely stranded (the bookkeeping that would have cleared 'syncing' never ran).
  const active = aliasedTable(sessions, 'active_session');
  const stranded = await db
    .select({
      sessionId: sessions.id,
      connectionId: sessions.connectionId,
      status: sessions.status,
      cost: sessions.cost,
      error: sessions.error,
      failureReason: sessions.failureReason,
      crawlMemory: sessions.crawlMemory,
    })
    .from(sessions)
    .innerJoin(connections, eq(connections.id, sessions.connectionId))
    .where(and(
      inArray(sessions.status, ['completed', 'failed']),
      eq(connections.status, 'syncing'),
      notExists(
        db
          .select({ one: active.id })
          .from(active)
          .where(and(
            eq(active.connectionId, sessions.connectionId),
            inArray(active.status, [...ACTIVE_SESSION_STATUSES]),
          )),
      ),
    ));

  // Promote a stranded SUCCESS: replay the occurrence-claimed staged records + success bookkeeping.
  async function promoteStranded(s: { sessionId: string; connectionId: string; cost: { totalCostUsd?: number } | null; crawlMemory: string | null }): Promise<void> {
    const staged = await db.select().from(stagedRecords).where(eq(stagedRecords.sessionId, s.sessionId));
    const store = await storeCrawlResults(db, {
      connectionId: s.connectionId,
      sessionId: s.sessionId,
      accounts: staged.filter((r) => r.kind === 'account').map((r) => r.data),
      transactions: staged.filter((r) => r.kind === 'transaction').map(stagedTransactionForStore),
      positions: staged.filter((r) => r.kind === 'position').map((r) => r.data),
    });
    await applyCrawlSuccess(db, s.connectionId, {
      crawlMemory: s.crawlMemory ?? undefined,
      costUsd: s.cost?.totalCostUsd,
      today: now,
      transactionsRejected:
        store.rejected.transactions + store.transactionsDropped,
    });
  }

  let recovered = 0;
  for (const s of stranded) {
    if (s.status === 'completed') {
      await promoteStranded(s);
    } else {
      // A failed session: nothing trustworthy to store — just reconcile the connection out of 'syncing'
      // and count the failure toward escalation.
      await applyCrawlFailure(db, s.connectionId, {
        error: s.error ?? 'recovered: crawl interrupted before bookkeeping',
        failureReason: s.failureReason ?? 'internal_error',
        costUsd: s.cost?.totalCostUsd,
      });
    }
    recovered++;
  }

  // Second sweep — ORPHANED SUCCESSES. The engine's success write deliberately leaves the session on
  // its last active status (the control-plane promotes, then flips to 'completed'). If this process
  // dies between the engine's durable 'done' event and the promotion, the row stays active until the
  // stale-heartbeat reaper would mark a perfectly successful crawl failed. Catch it here first: an
  // ACTIVE session whose connection is still 'syncing', whose lease has expired (a live runCrawl
  // promotes within seconds of 'done' AND still holds the lease — never race one), and which has a
  // successful 'done' event, is finished work awaiting promotion. Promote it and complete the session.
  const orphaned = await db
    .select({
      sessionId: sessions.id,
      connectionId: sessions.connectionId,
      cost: sessions.cost,
      crawlMemory: sessions.crawlMemory,
    })
    .from(sessions)
    .innerJoin(connections, eq(connections.id, sessions.connectionId))
    .where(and(
      inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
      eq(connections.status, 'syncing'),
      or(isNull(sessions.leaseExpiresAt), lt(sessions.leaseExpiresAt, now)),
      exists(
        db
          .select({ one: sessionEvents.id })
          .from(sessionEvents)
          .where(and(
            eq(sessionEvents.sessionId, sessions.id),
            eq(sessionEvents.type, 'done'),
          )),
      ),
    ));
  for (const s of orphaned) {
    // The 'done' event's success flag is authoritative: a failure 'done' commits together with the
    // 'failed' status flip, so an ACTIVE row with a done event is a success in the normal course —
    // but verify rather than assume (a partial out-of-band edit must not promote garbage).
    const [done] = await db
      .select({ data: sessionEvents.data })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, s.sessionId), eq(sessionEvents.type, 'done')))
      .limit(1);
    if ((done?.data as { success?: boolean } | null)?.success !== true) continue;
    await promoteStranded(s);
    await markSessionTerminal(db, s.sessionId, true);
    recovered++;
  }

  return { recovered };
}
