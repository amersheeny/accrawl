/**
 * Crawl session lifecycle = the per-connection lock + the crashed-engine reaper.
 *
 * The lock is structural: a partial UNIQUE index (sessions_active_connection_uq) allows at most one
 * session per connection while its status is active. Creating a session IS acquiring the lock — a
 * second concurrent attempt for the same connection fails the unique constraint and returns null,
 * so a scheduler retry can never start a second bank login. Completing/failing the session moves it
 * out of the active set and releases the lock.
 *
 * The engine heartbeats its session while it runs; if an instance dies mid-crawl the heartbeat goes
 * stale, and the reaper fails the session (releasing the lock) so the connection is never stuck "active"
 * forever and never reported falsely-successful.
 */
import { and, eq, inArray, lt, notExists, or, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections, sessionEvents, sessions } from '../db/schema';
import { postgresErrorCode } from '../lib/postgres-error';

export const ACTIVE_SESSION_STATUSES = [
  'starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting',
] as const;
/** Statuses that retain the one-crawl-per-connection lock. */
export const LOCKED_SESSION_STATUSES = [
  ...ACTIVE_SESSION_STATUSES,
  'cancelling',
] as const;

/** How long a session (and its cascaded events/steps/staged records + screenshot dir) is retained before
 *  the scheduler's retention sweep deletes it. Overridable via SESSION_RETENTION_DAYS. */
export function sessionRetentionDays(): number {
  const n = Number.parseInt(process.env.SESSION_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateSessionInput {
  connectionId: string;
  leaseOwner: string;
  leaseMs: number;
  /** Scheduled jobs carry the revision they claimed; manual crawls omit it. */
  expectedScheduleRevision?: number;
  /** Single-use occurrence token carried only by automatic scheduler jobs. */
  expectedScheduleClaim?: string;
}

/**
 * Acquire the per-connection crawl lock by creating an active session. Returns the new session id, or
 * null if a crawl is already active for the connection (the partial unique index rejects it).
 */
export async function createCrawlSession(db: Db, input: CreateSessionInput): Promise<string | null> {
  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      if (input.expectedScheduleRevision !== undefined) {
        const [connection] = await tx.select({
          crawlScheduleEnabled: connections.crawlScheduleEnabled,
          crawlScheduleRevision: connections.crawlScheduleRevision,
          crawlScheduleClaim: connections.crawlScheduleClaim,
        })
          .from(connections)
          .where(eq(connections.id, input.connectionId))
          .for('update')
          .limit(1);
        if (
          !connection?.crawlScheduleEnabled
          || connection.crawlScheduleRevision !== input.expectedScheduleRevision
          || !input.expectedScheduleClaim
          || connection.crawlScheduleClaim !== input.expectedScheduleClaim
        ) {
          return null;
        }
      }
      const [row] = await tx
        .insert(sessions)
        .values({
          connectionId: input.connectionId,
          status: 'starting',
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
          heartbeatAt: now,
          // TTL anchor for the retention sweep — set at creation so an interrupted run still ages out.
          expiresAt: new Date(now.getTime() + sessionRetentionDays() * DAY_MS),
        })
        // A held per-connection lock is an expected outcome, not an exceptional
        // transaction failure. Avoid aborting the transaction on the partial
        // unique index so both PostgreSQL and PGlite can return null cleanly.
        .onConflictDoNothing()
        .returning({ id: sessions.id });
      if (!row) return null;
      if (input.expectedScheduleRevision !== undefined) {
        await tx.update(connections)
          .set({ crawlScheduleClaim: null })
          .where(and(
            eq(connections.id, input.connectionId),
            eq(connections.crawlScheduleClaim, input.expectedScheduleClaim as string),
          ));
      }
      return row.id;
    });
  } catch (err) {
    if (postgresErrorCode(err) === '23505') return null; // a crawl already holds the lock
    throw err;
  }
}

/**
 * A scheduled tick marks the connection syncing before its queue send. If the
 * schedule is edited before that queued job acquires its session, the revision
 * fence rejects the stale job. Restore the status that the tick claimed only
 * when the revision is now stale and no real crawl owns the connection.
 */
export async function restoreStaleScheduleClaim(
  db: Db,
  input: {
    connectionId: string;
    expectedScheduleRevision: number;
    expectedScheduleClaim: string;
    priorStatus: (typeof connections.status.enumValues)[number];
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [connection] = await tx.select({
      crawlScheduleEnabled: connections.crawlScheduleEnabled,
      crawlScheduleRevision: connections.crawlScheduleRevision,
      crawlScheduleClaim: connections.crawlScheduleClaim,
      status: connections.status,
    })
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for('update')
      .limit(1);
    if (
      !connection
      || (connection.crawlScheduleClaim !== null
        && connection.crawlScheduleClaim !== input.expectedScheduleClaim)
      || (connection.crawlScheduleEnabled
        && connection.crawlScheduleRevision === input.expectedScheduleRevision)
      || connection.status !== 'syncing'
    ) {
      return false;
    }
    const [active] = await tx.select({ id: sessions.id })
      .from(sessions)
      .where(and(
        eq(sessions.connectionId, input.connectionId),
        inArray(sessions.status, [...LOCKED_SESSION_STATUSES]),
      ))
      .limit(1);
    if (active) return false;
    const restored = await tx.update(connections)
      .set({ status: input.priorStatus, updatedAt: new Date() })
      .where(and(
        eq(connections.id, input.connectionId),
        eq(connections.status, 'syncing'),
      ))
      .returning({ id: connections.id });
    return restored.length > 0;
  });
}

/**
 * Move a session to its terminal status (completed/failed), releasing the lock. Only transitions FROM an
 * active state: if the session was already made terminal — most importantly cancelled mid-crawl, but also
 * reaped or a double-call — this is a no-op, so an in-flight runCrawl finishing AFTER a cancel can never
 * clobber the 'cancelled' status back to completed/failed (the cancel must remain the recorded outcome).
 */
export async function markSessionTerminal(db: Db, sessionId: string, success: boolean, error?: string): Promise<void> {
  await db
    .update(sessions)
    .set({ status: success ? 'completed' : 'failed', error: error ? error.slice(0, 500) : null, completedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), inArray(sessions.status, [...ACTIVE_SESSION_STATUSES])));
}

/** Extend a running session's heartbeat + lease. */
export async function heartbeatSession(db: Db, sessionId: string, leaseMs: number): Promise<void> {
  const now = new Date();
  await db
    .update(sessions)
    .set({ heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + leaseMs) })
    .where(eq(sessions.id, sessionId));
}

/** A reaped session — its id plus the connection it held the lock for (so the caller can reconcile it). */
export interface ReapedSession {
  id: string;
  connectionId: string;
}

/**
 * Fail any active session whose heartbeat is older than `staleMs` (a crashed engine instance), releasing
 * its lock. To tolerate a GC/DB stall without prematurely killing a live crawl, the lease must ALSO have
 * expired (or be absent) before we release — a session is only reaped when BOTH the heartbeat is stale and
 * the lease is past. Returns the reaped sessions (id + owning connection) so the caller can fold the
 * failure into each connection's bookkeeping; just releasing the lock here would leave the connection
 * stuck 'syncing' with the failure uncounted toward escalation.
 */
export async function reapStaleSessions(db: Db, staleMs: number, now: Date = new Date()): Promise<ReapedSession[]> {
  const cutoff = new Date(now.getTime() - staleMs);
  const reaped = await db
    .update(sessions)
    .set({ status: 'failed', error: 'reaped: stale heartbeat (engine instance died)', completedAt: now })
    .where(and(
      inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
      lt(sessions.heartbeatAt, cutoff),
      // The lease backstops the heartbeat: never release a session whose lease is still valid, so a
      // transient stall that froze the heartbeat doesn't race the engine and steal its lock.
      or(isNull(sessions.leaseExpiresAt), lt(sessions.leaseExpiresAt, now)),
      // A session with a durable 'done' event is FINISHED work awaiting promotion, not a crashed
      // crawl: the engine stops heartbeating after its success write (which deliberately leaves the
      // status active until the control-plane promotes), so its heartbeat is ALWAYS stale here. It
      // belongs to the stranded-crawl sweeper (orphaned-success pass), never to the reaper — reaping
      // it would mislabel completed work as failed. (A failure 'done' commits together with the
      // 'failed' status flip, so no active row with a done event is ever a genuine failure.)
      notExists(
        db
          .select({ one: sessionEvents.id })
          .from(sessionEvents)
          .where(and(eq(sessionEvents.sessionId, sessions.id), eq(sessionEvents.type, 'done'))),
      ),
    ))
    .returning({ id: sessions.id, connectionId: sessions.connectionId });
  return reaped;
}
