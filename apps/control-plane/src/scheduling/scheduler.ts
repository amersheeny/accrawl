/**
 * Scheduler tick — the periodic sweep that keeps crawls flowing.
 *
 * Each tick: reap crashed sessions; self-heal (ensure a due-row for every verified connection); then
 * process every due connection:
 *   - back off a non-recoverable connection (needs_reauth/disabled) by 24h instead of re-checking it
 *     every minute or freezing it;
 *   - past MAX_CONSECUTIVE_CRAWL_FAILURES, escalate only an explicit rejected-credentials failure to
 *     needs_reauth; back off every non-auth failure for seven days without falsely blaming credentials;
 *   - otherwise enqueue a crawl, mark it 'syncing', and advance nextCrawlAt to the NEXT occurrence of the
 *     connection's own cron (crawlSchedule) — a malformed cron falls back to +24h so one bad recipe can't
 *     wedge the sweep.
 *
 * enqueueCrawl is injected so the tick is testable without the queue; in production it puts a job on the
 * pg-boss crawl queue whose worker runs runCrawl (one lock per connection still guards concurrency).
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  lte,
  notExists,
  or,
} from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections, connectionsDue, crawlJobs, sessions } from '../db/schema';
import {
  ACTIVE_SESSION_STATUSES,
  LOCKED_SESSION_STATUSES,
  reapStaleSessions,
} from '../data/sessions';
import {
  MAX_CONSECUTIVE_CRAWL_FAILURES,
  applyCrawlFailure,
  isAuthCrawlFailureReason,
} from '../data/crawl-bookkeeping';
import { recoverStrandedCrawls } from '../orchestration/recover-stranded-crawls';
import { config } from '../config';
import { CRAWL_JOB_STARTUP_GRACE_MS } from '../lib/crawl-budget';
import { nextRunFromCron } from './crawl-schedule';
import {
  isRecoverableConnectionStatus,
  RECOVERABLE_CONNECTION_STATUSES,
} from '../data/crawl-status';

export { nextRunFromCron } from './crawl-schedule';

export const RECOVERABLE_STATUSES = RECOVERABLE_CONNECTION_STATUSES;
export const isRecoverable = isRecoverableConnectionStatus;

const DAY_MS = 24 * 60 * 60 * 1000;
export const NON_AUTH_FAILURE_BACKOFF_MS = 7 * DAY_MS;
// The reaper only fires when BOTH the heartbeat is this stale AND the lease has expired. Set well above
// the ~30s heartbeat cadence so a GC pause or a brief DB stall that froze a few heartbeats doesn't kill a
// live crawl; the lease (sessions.leaseExpiresAt) is the real backstop, this is just the floor.
const DEFAULT_STALE_SESSION_MS = 5 * 60 * 1000; // 5 min

/** Self-heal: ensure an overdue due-row for every enabled verified connection lacking one. */
export async function ensureDueRows(db: Db, now: Date): Promise<number> {
  const verified = await db.select({ id: connections.id }).from(connections).where(and(
    eq(connections.loginDomainVerified, true),
    eq(connections.crawlScheduleEnabled, true),
  ));
  let created = 0;
  for (const c of verified) {
    const res = await db
      .insert(connectionsDue)
      .values({ connectionId: c.id, nextCrawlAt: now })
      .onConflictDoNothing()
      .returning({ id: connectionsDue.connectionId });
    if (res.length > 0) created++;
  }
  return created;
}

/** Root the engine writes session screenshots under (mirrors apps/engine's SCREENSHOT_DIR resolution):
 *  `${SCREENSHOT_DIR||RUNS_DIR||cwd/runs}/sessions/{id}`. */
function sessionsArtifactRoot(): string {
  const base = process.env.SCREENSHOT_DIR || process.env.RUNS_DIR || path.join(process.cwd(), 'runs');
  return path.join(base, 'sessions');
}

/**
 * Retention sweep: delete sessions past their expires_at (the cascade FKs drop their session_events /
 * session_steps / staged_records) and recursively remove each one's on-disk screenshot dir, so an
 * indefinitely-running self-host doesn't accumulate session telemetry + artifacts forever. The DB delete
 * drives it (works with or without the expires_at index); the filesystem cleanup is best-effort per dir so
 * one un-removable directory can't wedge the sweep. Returns how many sessions were purged.
 */
export async function sweepExpiredSessions(db: Db, now: Date): Promise<number> {
  const expired = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  if (expired.length === 0) return 0;

  const root = sessionsArtifactRoot();
  for (const s of expired) {
    try {
      await fs.rm(path.join(root, s.id), { recursive: true, force: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[scheduler] failed to remove screenshot dir for session ${s.id}:`, err);
    }
  }
  return expired.length;
}

/**
 * Reap a hosted worker that never started or stopped renewing its short job lease.
 * The crawl-job lease is stronger evidence than the longer orchestration lease, so
 * the owning session can be failed immediately and recovered by the normal stranded
 * crawl reconciler in this same tick.
 */
export async function reapStaleCrawlJobs(
  db: Db,
  now: Date,
  startupMs: number = CRAWL_JOB_STARTUP_GRACE_MS,
): Promise<number> {
  const startupCutoff = new Date(now.getTime() - startupMs);

  // A cancellation handler can die after durably locking the session but
  // before it marks the worker job. Reconcile that half-transition first so
  // the worker's next ownership heartbeat fences it.
  await db.update(crawlJobs)
    .set({ status: 'cancel_requested' })
    .where(and(
      inArray(crawlJobs.status, ['queued', 'starting', 'running']),
      exists(
        db.select({ id: sessions.id })
          .from(sessions)
          .where(and(
            eq(sessions.id, crawlJobs.sessionId),
            eq(sessions.status, 'cancelling'),
          )),
      ),
    ));

  const cancelled = await db.update(crawlJobs)
    .set({
      status: 'cancelled',
      error: 'cancelled by operator',
      completedAt: now,
      leaseExpiresAt: null,
      encryptedPayload: '',
      claimToken: '',
    })
    .where(and(
      eq(crawlJobs.status, 'cancel_requested'),
      or(isNull(crawlJobs.leaseExpiresAt), lt(crawlJobs.leaseExpiresAt, now)),
    ))
    .returning({ sessionId: crawlJobs.sessionId });

  for (const job of cancelled) {
    await db.update(sessions)
      .set({
        status: 'cancelled',
        error: null,
        completedAt: now,
      })
      .where(and(
        eq(sessions.id, job.sessionId),
        eq(sessions.status, 'cancelling'),
      ));
  }

  const stale = await db.update(crawlJobs)
    .set({
      status: 'failed',
      error: 'The crawl didn’t start or was interrupted. Try running the crawl again.',
      completedAt: now,
      leaseExpiresAt: null,
      encryptedPayload: '',
      claimToken: '',
    })
    .where(or(
      and(
        inArray(crawlJobs.status, ['queued', 'starting']),
        lt(crawlJobs.createdAt, startupCutoff),
      ),
      and(
        eq(crawlJobs.status, 'running'),
        or(isNull(crawlJobs.leaseExpiresAt), lt(crawlJobs.leaseExpiresAt, now)),
      ),
    ))
    .returning({ sessionId: crawlJobs.sessionId });

  for (const job of stale) {
    await db.update(sessions)
      .set({
        status: 'failed',
        error: 'The crawl didn’t start or was interrupted. Try running the crawl again.',
        failureReason: 'instance_died',
        completedAt: now,
      })
      .where(and(
        eq(sessions.id, job.sessionId),
        inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
      ));
  }

  // A confirmed terminal job is safe to release if the request handler died.
  // The HTTP path has no job row, so it retains the lock until heartbeat
  // staleness and its crawl lease both prove the old process is no longer live.
  const noJobFence = and(
    notExists(
      db.select({ id: crawlJobs.id })
        .from(crawlJobs)
        .where(eq(crawlJobs.sessionId, sessions.id)),
    ),
    or(
      isNull(sessions.heartbeatAt),
      lt(sessions.heartbeatAt, new Date(now.getTime() - DEFAULT_STALE_SESSION_MS)),
    ),
    or(isNull(sessions.leaseExpiresAt), lt(sessions.leaseExpiresAt, now)),
  );
  await db.update(sessions)
    .set({
      status: 'cancelled',
      error: null,
      completedAt: now,
    })
    .where(and(
      eq(sessions.status, 'cancelling'),
      or(
        exists(
          db.select({ id: crawlJobs.id })
            .from(crawlJobs)
            .where(and(
              eq(crawlJobs.sessionId, sessions.id),
              inArray(crawlJobs.status, ['succeeded', 'failed', 'cancelled']),
            )),
        ),
        noJobFence,
      ),
    ));

  return cancelled.length + stale.length;
}

export interface SchedulerDeps {
  enqueueCrawl: (
    connectionId: string,
    scheduleRevision: number,
    scheduleClaim: string,
    priorStatus: (typeof connections.status.enumValues)[number],
  ) => Promise<void>;
  now?: Date;
  staleSessionMs?: number;
}

export interface SchedulerTickResult {
  reaped: number;
  enqueued: number;
  escalated: number;
  backedOff: number;
  /** Stranded crawls (terminal session, connection still 'syncing') reconciled this tick. */
  recovered: number;
  /** Sessions purged by the retention sweep this tick. */
  purged: number;
  /** Ephemeral crawl workers reaped by their durable job lease. */
  jobsReaped: number;
}

export async function schedulerTick(db: Db, deps: SchedulerDeps): Promise<SchedulerTickResult> {
  const now = deps.now ?? new Date();
  // Reap crashed engines AND reconcile their connections: just releasing the lock would leave the
  // connection stuck 'syncing' with the failure uncounted, so the retry never escalates. applyCrawlFailure
  // moves it to 'error' (or needs_reauth past the threshold) and increments the streak, so a connection
  // whose engine keeps dying eventually escalates instead of looping forever.
  const reapedSessions = await reapStaleSessions(db, deps.staleSessionMs ?? DEFAULT_STALE_SESSION_MS, now);
  for (const s of reapedSessions) {
    await applyCrawlFailure(db, s.connectionId, { error: 'reaped: stale heartbeat', failureReason: 'instance_died' });
  }
  const reaped = reapedSessions.length;

  const jobsReaped = await reapStaleCrawlJobs(db, now);

  // Durably recover crawls interrupted between staging and bookkeeping (terminal session, connection still
  // 'syncing'): re-promote their staged extraction and reconcile the connection. Runs AFTER the reaper so a
  // freshly-reaped session (now connection='error') isn't picked up here.
  const { recovered } = await recoverStrandedCrawls(db, now);

  // Age out old sessions + their cascaded telemetry/artifacts.
  const purged = await sweepExpiredSessions(db, now);

  await ensureDueRows(db, now);

  // Candidate list only — connectionId is enough; the per-connection transaction below re-reads live state.
  const due = await db
    .select({ connectionId: connectionsDue.connectionId })
    .from(connectionsDue)
    .where(lte(connectionsDue.nextCrawlAt, now));

  let enqueued = 0;
  let escalated = 0;
  let backedOff = 0;
  const backoff = new Date(now.getTime() + DAY_MS);

  // The due-select above is only a candidate list (its status/failures are a snapshot that can go stale).
  // Decide each connection under a row lock so every branch reads LIVE state — eliminating the whole class
  // of stale-snapshot races (wrong back-off/escalate/enqueue) and the double-claim, in one place. The
  // enqueue itself happens AFTER the transaction so a slow queue send never holds the lock.
  const toEnqueue: Array<{
    cid: string;
    nextRun: Date;
    priorStatus: (typeof connections.status.enumValues)[number];
    scheduleRevision: number;
    scheduleClaim: string;
  }> = [];

  for (const d of due) {
    const decision = await db.transaction(async (tx) => {
      // Lock the due row first (the dedup point) and re-read it: a concurrent tick that already claimed it
      // advanced nextCrawlAt past now, so we skip — no double-claim.
      const [dueRow] = await tx
        .select({ nextCrawlAt: connectionsDue.nextCrawlAt })
        .from(connectionsDue)
        .where(eq(connectionsDue.connectionId, d.connectionId))
        .for('update')
        .limit(1);
      if (!dueRow || dueRow.nextCrawlAt > now) return { kind: 'skip' as const };

      // Lock the connection and read its LIVE status/failures/schedule (never the stale due-select values),
      // so a concurrent reauth/disconnect/crawl-completion can't make this decision wrong.
      const [conn] = await tx
        .select({
          status: connections.status,
          consecutiveFailures: connections.consecutiveFailures,
          crawlScheduleEnabled: connections.crawlScheduleEnabled,
          crawlSchedule: connections.crawlSchedule,
          crawlTimezone: connections.crawlTimezone,
          crawlScheduleRevision: connections.crawlScheduleRevision,
          crawlStats: connections.crawlStats,
        })
        .from(connections)
        .where(eq(connections.id, d.connectionId))
        .for('update')
        .limit(1);
      if (!conn) return { kind: 'skip' as const };

      if (!conn.crawlScheduleEnabled) {
        await tx.delete(connectionsDue).where(eq(connectionsDue.connectionId, d.connectionId));
        return { kind: 'skip' as const };
      }

      if (!isRecoverable(conn.status)) {
        await tx.update(connectionsDue).set({ nextCrawlAt: backoff }).where(eq(connectionsDue.connectionId, d.connectionId));
        return { kind: 'backedOff' as const };
      }
      if (conn.consecutiveFailures > MAX_CONSECUTIVE_CRAWL_FAILURES) {
        if (isAuthCrawlFailureReason(conn.crawlStats?.lastFailureReason)) {
          await tx.update(connections).set({ status: 'needs_reauth', updatedAt: now }).where(eq(connections.id, d.connectionId));
          await tx.update(connectionsDue).set({ nextCrawlAt: backoff }).where(eq(connectionsDue.connectionId, d.connectionId));
          return { kind: 'escalated' as const };
        }

        const weeklyRetry = new Date(now.getTime() + NON_AUTH_FAILURE_BACKOFF_MS);
        await tx.update(connectionsDue).set({ nextCrawlAt: weeklyRetry }).where(eq(connectionsDue.connectionId, d.connectionId));
        // eslint-disable-next-line no-console
        console.error(
          `[scheduler] connection ${d.connectionId} is persistently failing for a non-auth reason `
          + `(reason=${conn.crawlStats?.lastFailureReason ?? 'unknown'}); retaining error status and retrying in 7 days`,
        );
        return { kind: 'backedOff' as const };
      }
      // Eligible: claim (advance nextCrawlAt) + flip to syncing, atomically under both locks.
      const nextRun = nextRunFromCron(conn.crawlSchedule, conn.crawlTimezone, now);
      const scheduleClaim = randomUUID();
      await tx.update(connectionsDue).set({ nextCrawlAt: nextRun }).where(eq(connectionsDue.connectionId, d.connectionId));
      await tx.update(connections).set({
        status: 'syncing',
        crawlScheduleClaim: scheduleClaim,
        updatedAt: now,
      }).where(eq(connections.id, d.connectionId));
      return {
        kind: 'claimed' as const,
        nextRun,
        priorStatus: conn.status,
        scheduleRevision: conn.crawlScheduleRevision,
        scheduleClaim,
      };
    });

    if (decision.kind === 'claimed') toEnqueue.push({
      cid: d.connectionId,
      nextRun: decision.nextRun,
      priorStatus: decision.priorStatus,
      scheduleRevision: decision.scheduleRevision,
      scheduleClaim: decision.scheduleClaim,
    });
    else if (decision.kind === 'backedOff') backedOff++;
    else if (decision.kind === 'escalated') escalated++;
  }

  // Enqueue claimed connections after their transactions committed. On failure, roll the claim back — but
  // only if it's still ours (nextCrawlAt unchanged), so a late failure can't clobber a newer tick.
  for (const {
    cid, nextRun, priorStatus, scheduleRevision, scheduleClaim,
  } of toEnqueue) {
    try {
      await deps.enqueueCrawl(cid, scheduleRevision, scheduleClaim, priorStatus);
      enqueued++;
    } catch (err) {
      const rolledBack = await db.transaction(async (tx) => {
        const [dueRow] = await tx.select({ nextCrawlAt: connectionsDue.nextCrawlAt })
          .from(connectionsDue)
          .where(eq(connectionsDue.connectionId, cid))
          .for('update')
          .limit(1);
        const [connection] = await tx.select({
          status: connections.status,
          crawlScheduleEnabled: connections.crawlScheduleEnabled,
          crawlScheduleRevision: connections.crawlScheduleRevision,
          crawlScheduleClaim: connections.crawlScheduleClaim,
        })
          .from(connections)
          .where(eq(connections.id, cid))
          .for('update')
          .limit(1);
        if (!connection) return false;
        const exactClaim = connection.crawlScheduleRevision === scheduleRevision
          && connection.crawlScheduleClaim === scheduleClaim;
        const supersededByEdit = connection.crawlScheduleClaim === null
          && (
            connection.crawlScheduleRevision !== scheduleRevision
            || !connection.crawlScheduleEnabled
          );
        if (!exactClaim && !supersededByEdit) return false;
        const [active] = await tx.select({ id: sessions.id })
          .from(sessions)
          .where(and(
            eq(sessions.connectionId, cid),
            inArray(sessions.status, [...LOCKED_SESSION_STATUSES]),
          ))
          .limit(1);
        if (active) return false;
        if (exactClaim && dueRow?.nextCrawlAt.getTime() === nextRun.getTime()) {
          await tx.update(connectionsDue)
            .set({ nextCrawlAt: now })
            .where(eq(connectionsDue.connectionId, cid));
        }
        await tx.update(connections)
          .set({
            status: connection.status === 'syncing' ? priorStatus : connection.status,
            ...(exactClaim ? { crawlScheduleClaim: null } : {}),
            updatedAt: now,
          })
          .where(eq(connections.id, cid));
        return true;
      });
      // eslint-disable-next-line no-console
      console.error(`[scheduler] enqueueCrawl failed for ${cid}; ${rolledBack ? 'rolled back claim' : 'claim already consumed or superseded'}:`, err);
    }
  }
  return { reaped, enqueued, escalated, backedOff, recovered, purged, jobsReaped };
}
