/**
 * Crawl orchestration controller — wires the 2d primitives into one run:
 *
 *   lock (createCrawlSession) → load connection+institution → REFUSE if the login domain isn't
 *   operator-verified (anti-phishing) → decrypt credentials → assemble the CrawlRequest (cutoff window,
 *   existing accounts/positions/recentTransactions + the private Rule-4 target snapshot, allowedDomains) → dispatch
 *   to the engine → read its STAGED records → validate+store into the canonical tables → fold the
 *   outcome into the connection's bookkeeping → finalize the session (release the lock).
 *
 * The engine HTTP call is injected (`deps.dispatchCrawl`) so the control logic is testable without a
 * live engine. The dispatch is a short ACK; the crawl OUTCOME is read from the session row the engine
 * maintains (waitForSessionTerminal below) — never from a held HTTP response, which dies on standard
 * ~5-minute client/proxy header timeouts. A crashed engine that never reports is caught here by the
 * completion deadline and, independently, by the heartbeat reaper, so a connection is never left locked
 * or reported falsely-successful.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  positions,
  transactions,
  connections,
  institutions,
  sessions,
  sessionEvents,
  stagedRecords,
  sessionTransactionTargets,
} from '../db/schema';
import {
  buildRecentTransactionHistory, deriveTunnelKey, HOSTED_COPY, signTunnelToken,
  type CrawlAck, type CrawlFailureReason, type CrawlRequest, type NormalizedAccount, type NormalizedPosition, type NormalizedTransaction,
} from '@accrawl/contracts';
import { decryptConnectionCredentials } from '../data/connections';
import { bindPairedDeviceToSession } from '../data/devices';
import { isHostWithinDomain } from '../lib/domain';
import { isRecoverableConnectionStatus } from '../data/crawl-status';
import {
  deriveTransactionCutoffDate,
} from '../data/tx-identity';
import { stagedTransactionForStore, storeCrawlResults, type StoreCrawlResult } from '../data/store-crawl';
import { applyCrawlSuccess, applyCrawlFailure } from '../data/crawl-bookkeeping';
import { dispatchCrawlWebhook, dispatchSyncOutcomeWebhooks } from '../webhooks/dispatch';
import { createCrawlSession, markSessionTerminal } from '../data/sessions';
import {
  DEFAULT_LEASE_MS,
  MAX_CRAWL_SECONDS,
} from '../lib/crawl-budget';
import { currentTenant } from '../tenancy/context';
import {
  finalizeSessionCancellation,
  finalizeSessionFailureAfterFence,
  requestSessionCancellation,
} from '../data/cancel-session';
import { dispatchCancelToEngine } from './dispatch-engine';
import {
  sendCompanionWake,
  type CompanionWakeInput,
  type CompanionWakeResult,
} from '../notifications/companion-push';

export interface RunCrawlDeps {
  /** Send the request to the engine and resolve with its immediate ACK (the crawl runs in the background). */
  dispatchCrawl: (request: CrawlRequest) => Promise<CrawlAck>;
  leaseOwner: string;
  leaseMs?: number;
  today?: Date;
  /** How often to check the session row for the engine's terminal write (default 2s). */
  pollIntervalMs?: number;
  /** Override the completion deadline (hosted default: Job startup allowance + timeoutSeconds + 90s). */
  completionDeadlineMs?: number;
  /** Positively fence browser execution before a timed-out session releases its lock. */
  fenceCrawl?: (sessionId: string) => Promise<unknown>;
  /** Wake the exact bound Companion after the tunnel request is durable. */
  wakeCompanion?: (
    db: Db,
    input: CompanionWakeInput,
  ) => Promise<CompanionWakeResult>;
}

/** Headroom past the crawl's own timeout before we stop waiting for the engine to report: the engine's
 *  hard watchdog fires at timeoutSeconds + 30s, so a healthy engine always reports well within this. */
const ENGINE_COMPLETION_GRACE_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TERMINAL_SESSION_STATUSES = ['completed', 'failed', 'cancelled'] as const;

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Point-of-use guard (same principle as the timeoutSeconds clamp below): the route validates the
 *  enum on write, but the column is plain text — a row edited out-of-band must degrade to the engine
 *  default, never fail the whole crawl with an engine-side 400. */
function sanitizeThinkingLevel(value: string | null): ThinkingLevel | undefined {
  return (THINKING_LEVELS as readonly string[]).includes(value ?? '') ? (value as ThinkingLevel) : undefined;
}

interface FinalSessionState {
  status: string;
  error: string | null;
  failureReason: string | null;
  cost: unknown;
  crawlMemory: string | null;
}

interface EngineOutcome {
  row: FinalSessionState;
  /** True when the engine finished SUCCESSFULLY (its 'done' event) and the staged extraction awaits
   *  promotion — the row's status is deliberately still active: the engine never flips a session to
   *  'completed', so an observable 'completed' always means the data is already promoted. */
  succeededAwaitingPromotion: boolean;
}

/** Poll until the engine reports its outcome, or the deadline passes (null). Two channels, by design:
 *  a FAILURE (or a cancel/reap) flips the session row to a terminal status directly; a SUCCESS is the
 *  engine's atomic 'done' event + staged records, after which the caller promotes and flips the status
 *  to 'completed' itself — see the engine's completeSession for why. */
async function waitForEngineOutcome(
  db: Db,
  sessionId: string,
  deadlineAt: number,
  pollIntervalMs: number,
): Promise<EngineOutcome | null> {
  for (;;) {
    const [row] = await db
      .select({
        status: sessions.status,
        error: sessions.error,
        failureReason: sessions.failureReason,
        cost: sessions.cost,
        crawlMemory: sessions.crawlMemory,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (row && (TERMINAL_SESSION_STATUSES as readonly string[]).includes(row.status)) {
      return { row, succeededAwaitingPromotion: false };
    }
    if (row) {
      // `cancelling` deliberately keeps the connection lock until orchestration
      // proves the worker is gone. Ignore even a late `done` event in this phase:
      // the cancellation owner (or its lease-fence reconciler) must publish the
      // terminal `cancelled` state before bookkeeping can proceed.
      if (row.status === 'cancelling') {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return null;
        await sleep(Math.min(pollIntervalMs, remaining));
        continue;
      }
      const [done] = await db
        .select({ data: sessionEvents.data })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.type, 'done')))
        .limit(1);
      if (done) {
        const success = (done.data as { success?: boolean } | null)?.success === true;
        if (success) return { row, succeededAwaitingPromotion: true };
        // A failure 'done' whose status flip didn't land (shouldn't happen — the two commit together).
        return { row: { ...row, status: 'failed', error: row.error ?? 'crawl failed' }, succeededAwaitingPromotion: false };
      }
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

export interface RunCrawlResult {
  outcome: 'completed' | 'failed' | 'locked';
  sessionId?: string;
  store?: StoreCrawlResult;
  error?: string;
}

export async function runCrawl(
  db: Db,
  deps: RunCrawlDeps,
  input: {
    connectionId: string;
    expectedScheduleRevision?: number;
    expectedScheduleClaim?: string;
  },
): Promise<RunCrawlResult> {
  const tenant = currentTenant();
  // 1. Acquire the per-connection lock.
  const sessionId = await createCrawlSession(db, {
    connectionId: input.connectionId,
    leaseOwner: deps.leaseOwner,
    leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS,
    expectedScheduleRevision: input.expectedScheduleRevision,
    expectedScheduleClaim: input.expectedScheduleClaim,
  });
  if (!sessionId) return { outcome: 'locked' };
  const sid = sessionId; // narrowed to string; captured by finishSession below
  // One clock reading governs the cutoff, comparison window, and success
  // watermark. A crawl crossing UTC midnight must not use two different days.
  const crawlToday = deps.today ? new Date(deps.today.getTime()) : new Date();

  // Captured before any bookkeeping so finishSession can emit connection.status_changed, and set on the
  // success path so it can emit transactions.updated with the store's change counts.
  let statusBefore: string | undefined;
  let storeCounts: { added: number; modified: number } | undefined;

  // Every terminal outcome goes through here: record the session terminal AND fire the outcome webhooks.
  // Both the legacy crawl webhook and the normalized (crawl-free) sync webhooks are FIRE-AND-FORGET (void)
  // — a slow/failing receiver must never block or fail a crawl; the outcome is already durably recorded and
  // the receiver's poll-fallback (GET /api/sessions/:id, GET /api/v1/syncs/:id) covers a miss.
  const finishSession = async (success: boolean, error?: string): Promise<void> => {
    await markSessionTerminal(db, sid, success, error);
    void dispatchCrawlWebhook(db, {
      connectionId: input.connectionId,
      sessionId: sid,
      event: success ? 'crawl.completed' : 'crawl.failed',
      error,
    }).catch((err) => console.warn('[webhooks] crawl-outcome dispatch failed:', err instanceof Error ? err.message : err));
    void dispatchSyncOutcomeWebhooks(db, {
      connectionId: input.connectionId,
      syncId: sid,
      success,
      error,
      statusBefore,
      counts: success ? storeCounts : undefined,
    }).catch((err) => console.warn('[webhooks] sync-outcome dispatch failed:', err instanceof Error ? err.message : err));
  };

  try {
    const [conn] = await db.select().from(connections).where(eq(connections.id, input.connectionId)).limit(1);
    if (!conn) throw new Error(HOSTED_COPY.connectionNotFound);
    statusBefore = conn.status; // baseline for the connection.status_changed webhook
    const [inst] = await db.select().from(institutions).where(eq(institutions.id, conn.institutionId)).limit(1);
    if (!inst) throw new Error('institution not found');

    // 1b. Point of use: the worker is the authoritative gate. The scheduler's enqueue (or a manual
    // crawl-now) is best-effort, so the connection may have become non-crawlable (disabled/needs_reauth)
    // since it was enqueued. Re-check the LIVE status here before doing any credential work.
    if (!isRecoverableConnectionStatus(conn.status)) {
      const error = 'This connection must be enabled and signed in before the crawl can start.';
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    // 2. Anti-phishing: never type credentials into an unverified login domain.
    if (!conn.loginDomainVerified) {
      const error = 'This institution’s login domain hasn’t been verified, so the crawl can’t start.';
      await applyCrawlFailure(db, input.connectionId, { error, failureReason: 'internal_error' });
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    // 2b. Anti-phishing at the POINT OF USE: a stored loginUrlOverride is validated when set, but an
    // institution domain change can leave it stale/off-domain. Never dispatch credentials to an override
    // that no longer sits within the institution's current canonical domain.
    if (conn.loginUrlOverride && !isHostWithinDomain(conn.loginUrlOverride, inst.canonicalDomain)) {
      const error = 'The saved login address doesn’t match this institution’s domain.';
      await applyCrawlFailure(db, input.connectionId, { error, failureReason: 'internal_error' });
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    // 2c. Supply-chain gate (§3): NEVER run a config whose malice-scan hasn't passed. An imported/community
    // config enters as scanStatus 'pending' and only becomes 'passed' after the LLM malice-scan clears it; a
    // config that failed the scan or couldn't be scanned (still 'pending') must not run hostile instructions
    // inside the user's authenticated bank session. Operator-authored local configs are 'passed' on create.
    if (inst.scanStatus !== 'passed') {
      const error = 'The crawl can’t start until its safety check passes.';
      await applyCrawlFailure(db, input.connectionId, { error, failureReason: 'internal_error' });
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    // 3. Decrypt credentials (control-plane → engine over the trusted internal call).
    const creds = decryptConnectionCredentials(conn);

    // 4. Assemble existing data + the cutoff window.
    const existingAccounts = (await db.select().from(accounts).where(eq(accounts.connectionId, input.connectionId)))
      .map((r) => {
        const d = r.data as NormalizedAccount;
        return { providerAccountId: d.providerAccountId, name: d.name, description: d.description, currency: d.currency, type: d.type, balance: d.balance };
      });
    const existingPositions = (await db.select().from(positions).where(eq(positions.connectionId, input.connectionId)))
      .map((r) => {
        const d = r.data as NormalizedPosition;
        return {
          providerPositionId: d.providerPositionId,
          providerAccountId: d.providerAccountId,
          symbol: d.symbol ?? '',
          name: d.name,
          currency: d.currency,
          quantity: d.quantity,
        };
      });

    const txRows = await db
      .select({ id: transactions.id, data: transactions.data })
      .from(transactions)
      .where(eq(transactions.connectionId, input.connectionId));
    const cutoffDate = deriveTransactionCutoffDate({
      lastSuccessfulCrawlDay: conn.crawlStats.lastSuccessfulTxCrawlDay,
      today: crawlToday,
    });
    // Floor for an account we hold no transactions for. `cutoffDate` is justified
    // by "we already hold everything older", which is false for such an account,
    // so it gets the floor storage itself enforces — no wider, so nothing
    // extracted under it is dropped on the way in.
    const historyFloorDate = deriveTransactionCutoffDate({ today: crawlToday });
    // Computed from EVERY stored row, never from the windowed comparison list: an
    // account whose only transactions predate the window is absent from that list
    // yet is fully stored, and exempting it would re-extract its history as new.
    // Discovery and history capture land in different crawls — the crawl that
    // finds an account is bounded by the connection's window — so "known" is not
    // the same as "has history", and it is the empty ones that need the floor.
    const accountsWithStoredHistory = new Set(
      txRows.map((row) => row.data.providerAccountId).filter(Boolean),
    );
    const accountsWithoutStoredHistory = existingAccounts
      .map((account) => account.providerAccountId)
      .filter((providerAccountId) => !accountsWithStoredHistory.has(providerAccountId));
    const hasPriorSuccessfulCrawl = Boolean(
      conn.crawlStats.lastSuccessfulTxCrawlDay,
    );
    // First crawl: no comparison list. Later crawls: the complete, untruncated
    // list on or after the inclusive seven-UTC-day lower bound. Match the
    // crawler's prior-data contract by retaining future-dated stored rows and
    // ordering every supplied row by bookingDate descending.
    const recentTransactionRows = hasPriorSuccessfulCrawl
      ? txRows.filter((row) =>
        row.data.bookingDate >= cutoffDate)
        .sort((left, right) =>
          right.data.bookingDate.localeCompare(left.data.bookingDate))
      : [];
    const recentTransactionHistory = buildRecentTransactionHistory(
      recentTransactionRows.map((row) => ({
        providerAccountId: row.data.providerAccountId ?? '',
        providerTransactionId: row.data.providerTransactionId,
        bookingDate: row.data.bookingDate,
        amount: row.data.amount,
        currency: row.data.currency,
        description: row.data.description,
        isPending: row.data.isPending,
      })),
    );
    const recentTransactions = recentTransactionHistory.transactions;

    // Persist the private half of the exact list supplied to the crawler before
    // dispatch. The crawler sees canonical values only; live promotion and
    // stranded recovery both resolve them back to these immutable row ids.
    // Chunking avoids PostgreSQL's bind-parameter ceiling for pathological but
    // deliberately untruncated transaction windows.
    const targetRows = recentTransactionRows.map((row) => ({
      sessionId,
      providerAccountId: row.data.providerAccountId ?? '',
      canonicalId: row.data.providerTransactionId,
      transactionId: row.id,
    }));
    for (let offset = 0; offset < targetRows.length; offset += 500) {
      await db.insert(sessionTransactionTargets).values(targetRows.slice(offset, offset + 500));
    }

    // 4b. Device-proxy gate. An institution flagged useDeviceProxy must route the browser's egress through
    // a paired device explicitly granted this connection. Resolve and durably bind that device, then mint
    // the session+device-bound tunnel token; the engine verifies it with a key derived from the same
    // ENGINE_SHARED_SECRET. Fail fast instead of silently falling back to direct egress.
    let deviceProxy: { useDeviceProxy: true; tunnelToken: string } | undefined;
    if (inst.useDeviceProxy) {
      if (!tenant.engineSharedSecret) {
        const error = 'Accrawl isn’t configured to route crawls through a phone’s network.';
        await applyCrawlFailure(db, input.connectionId, { error, failureReason: 'internal_error' });
        await finishSession(false, error);
        return { outcome: 'failed', sessionId, error };
      }
      const device = await bindPairedDeviceToSession(db, sessionId, conn.ownerSubject);
      if (!device) {
        const error = 'None of the paired phones is allowed to crawl this connection.';
        await applyCrawlFailure(db, input.connectionId, { error, failureReason: 'internal_error' });
        await finishSession(false, error);
        return { outcome: 'failed', sessionId, error };
      }
      const tunnelToken = signTunnelToken(deriveTunnelKey(tenant.engineSharedSecret), { sid: sessionId, did: device.id });
      deviceProxy = { useDeviceProxy: true, tunnelToken };
      try {
        await (deps.wakeCompanion ?? sendCompanionWake)(db, {
          ownerSubject: conn.ownerSubject,
          connectionId: conn.id,
          deviceId: device.id,
          data: {
            type: 'tunnel',
            sessionId,
            institutionId: inst.id,
            institutionName: inst.name,
            ...(conn.nickname?.trim()
              ? { connectionName: conn.nickname.trim() }
              : {}),
          },
        });
      } catch (error) {
        // The request is already durable and Companion recovers pending
        // sessions on launch/sign-in/resume. Preserve that recovery path when
        // the best-effort wake transport is temporarily unavailable.
        console.warn(
          `[companion-push] tunnel wake failed for session ${sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // 5. Build the CrawlRequest.
    const request: CrawlRequest = {
      sessionId,
      loginUrl: conn.loginUrlOverride ?? inst.loginUrl,
      allowedDomains: inst.allowedDomains,
      username: creds.username,
      password: creds.password,
      dob: creds.dob,
      phone: creds.phone,
      playbook: inst.playbook ?? undefined,
      customInstructions: conn.customInstructions ?? undefined,
      requires2fa: inst.requires2fa,
      otpSenderPattern: inst.otpSenderPattern ?? undefined,
      country: inst.country ?? undefined,
      maxSteps: inst.maxSteps,
      // Enforce the 30-min ceiling at the point of use, not just at input validation: a row stored before the
      // ceiling was lowered (or a direct DB edit) could still carry a larger timeout, and it must never let a
      // crawl outrun its lock lease (= CRAWL_EXPIRE). The input schema also caps new values at MAX_CRAWL_SECONDS.
      timeoutSeconds: Math.min(inst.timeoutSeconds, MAX_CRAWL_SECONDS),
      model: inst.model ?? undefined,
      thinkingLevel: sanitizeThinkingLevel(inst.thinkingLevel),
      existingAccounts,
      existingPositions,
      recentTransactions,
      recentTransactionsManifest: recentTransactionHistory.manifest,
      cutoffDate,
      historyFloorDate,
      accountsWithoutStoredHistory,
      crawlMemory: conn.crawlMemory ?? undefined,
      ...deviceProxy,
    };

    // 6. Dispatch to the engine (short ACK — the engine runs the crawl in the background and writes
    // staged_records + session telemetry as it goes, finishing with the terminal session write).
    const ack = await deps.dispatchCrawl(request);
    if (!ack.accepted) {
      const error = ack.error ?? 'engine did not accept the crawl';
      await applyCrawlFailure(db, input.connectionId, { error, failureReason: 'instance_died' });
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    // 6b. Await the engine's terminal write. A missing outcome never releases
    // the connection lock until the execution has been positively fenced.
    const deadlineAt = Date.now() + (
      deps.completionDeadlineMs
      ?? request.timeoutSeconds * 1000 + ENGINE_COMPLETION_GRACE_MS
    );
    let outcome = await waitForEngineOutcome(db, sid, deadlineAt, deps.pollIntervalMs ?? 2000);
    if (!outcome) {
      const error = 'The crawl didn’t finish within the allowed time.';
      const cancellation = await requestSessionCancellation(db, sid);

      if (cancellation === 'cancellation_requested' || cancellation === 'already_cancelling') {
        await (deps.fenceCrawl ?? dispatchCancelToEngine)(sid);
        if (cancellation === 'cancellation_requested') {
          await finalizeSessionFailureAfterFence(db, sid, error);
          await applyCrawlFailure(db, input.connectionId, {
            error,
            failureReason: 'instance_died',
          });
          await finishSession(false, error);
          return { outcome: 'failed', sessionId, error };
        }
        // An operator already owns cancellation. Help it establish the same
        // execution fence, then preserve the user-requested cancelled outcome.
        await finalizeSessionCancellation(db, sid);
      }

      // Completion may have committed between the final poll and the row lock.
      // Re-read after the serialized cancellation decision instead of
      // overwriting that authoritative outcome.
      outcome = await waitForEngineOutcome(
        db,
        sid,
        Date.now() + ENGINE_COMPLETION_GRACE_MS,
        deps.pollIntervalMs ?? 2000,
      );
      if (!outcome) {
        throw new Error(error);
      }
    }

    const final = outcome.row;
    const costUsd = (final.cost as { totalCostUsd?: number } | null)?.totalCostUsd;

    if (final.status === 'cancelled') {
      // The operator stopped the crawl. The row already carries the terminal 'cancelled' state
      // (markSessionTerminal inside finishSession is a guarded no-op) — this only runs the
      // bookkeeping so the connection leaves 'syncing', and fires the outcome webhook.
      const error = final.error ?? 'cancelled by operator';
      await applyCrawlFailure(db, input.connectionId, { error, failureReason: (final.failureReason as CrawlFailureReason | null) ?? undefined, costUsd });
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    if (final.status === 'completed') {
      // Already promoted by someone else (e.g. the stranded-crawl sweeper won a restart race) —
      // 'completed' is only ever written AFTER promotion, so there is nothing left to do.
      return { outcome: 'completed', sessionId };
    }

    if (!outcome.succeededAwaitingPromotion) {
      const error = final.error ?? 'crawl failed';
      await applyCrawlFailure(db, input.connectionId, { error, failureReason: (final.failureReason as CrawlFailureReason | null) ?? undefined, costUsd });
      await finishSession(false, error);
      return { outcome: 'failed', sessionId, error };
    }

    // 7. Read the engine's STAGED extraction and validate+store it into the canonical tables.
    const staged = await db.select().from(stagedRecords).where(eq(stagedRecords.sessionId, sessionId));
    const store = await storeCrawlResults(db, {
      connectionId: input.connectionId,
      sessionId,
      accounts: staged.filter((s) => s.kind === 'account').map((s) => s.data),
      transactions: staged.filter((s) => s.kind === 'transaction').map(stagedTransactionForStore),
      positions: staged.filter((s) => s.kind === 'position').map((s) => s.data),
    });
    // Change counts for the transactions.updated webhook (fired by finishSession on success) AND for the
    // Sync resource (GET /api/v1/syncs/:id, spec §12.3) — persisted on the session so a consumer polling
    // after completion sees what changed.
    storeCounts = { added: store.transactionsAdded, modified: store.transactionsModified };
    await db.update(sessions)
      .set({ syncCounts: { accounts: store.accountsStored, transactionsAdded: store.transactionsAdded, transactionsModified: store.transactionsModified } })
      .where(eq(sessions.id, sid));

    // A successful crawl has completed extraction of every supported financial
    // data surface, including a legitimately empty transaction window.
    // Rejected or identity-dropped transaction observations keep the watermark
    // unchanged so the same window is revisited rather than skipped.
    await applyCrawlSuccess(db, input.connectionId, {
      crawlMemory: final.crawlMemory ?? undefined,
      costUsd,
      today: crawlToday,
      transactionsRejected:
        store.rejected.transactions + store.transactionsDropped,
    });
    await finishSession(true);
    return { outcome: 'completed', sessionId, store };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await applyCrawlFailure(db, input.connectionId, { error: message, failureReason: 'internal_error' });
    await finishSession(false, message);
    return { outcome: 'failed', sessionId, error: message };
  }
}
