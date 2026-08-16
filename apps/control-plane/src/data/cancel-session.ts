/** Durable, two-phase operator cancellation.
 *
 * `cancelling` rejects crawler progress but remains inside the partial unique
 * lock, preventing a replacement crawl from starting. Only after orchestration
 * proves the old worker is terminated or self-fenced does `cancelled` release
 * that lock. Both transitions are atomic and idempotent.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessionEvents, sessions } from '../db/schema';
import { ACTIVE_SESSION_STATUSES } from './sessions';

export type RequestCancellationResult =
  | 'cancellation_requested'
  | 'already_cancelling'
  | 'already_cancelled'
  | 'not_found'
  | 'already_terminal';

/**
 * Request cancellation without releasing the per-connection lock.
 */
export async function requestSessionCancellation(
  db: Db,
  id: string,
): Promise<RequestCancellationResult> {
  return db.transaction(async (tx) => {
    // Completion and cancellation take the same session-row lock. At READ
    // COMMITTED, this SELECT obtains a fresh row after any older writer commits;
    // the separate event SELECT below then gets a new statement snapshot too.
    // That second statement is essential for rolling upgrades: an old worker
    // may write successful `done` without promotion_ready_at.
    const [current] = await tx.select({
      status: sessions.status,
      promotionReadyAt: sessions.promotionReadyAt,
    })
      .from(sessions)
      .where(eq(sessions.id, id))
      .for('update')
      .limit(1);
    if (!current) return 'not_found';
    if (current.status === 'cancelling') return 'already_cancelling';
    if (current.status === 'cancelled') return 'already_cancelled';
    if (
      !ACTIVE_SESSION_STATUSES.includes(
        current.status as (typeof ACTIVE_SESSION_STATUSES)[number],
      )
      || current.promotionReadyAt
    ) {
      return 'already_terminal';
    }

    const [successfulDone] = await tx.select({ sessionId: sessionEvents.sessionId })
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.sessionId, id),
        eq(sessionEvents.type, 'done'),
        sql`${sessionEvents.data}->>'success' = 'true'`,
      ))
      .limit(1);
    if (successfulDone) return 'already_terminal';

    const updated = await tx
      .update(sessions)
      .set({ status: 'cancelling', error: null })
      .where(and(
        eq(sessions.id, id),
        inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
        isNull(sessions.promotionReadyAt),
      ))
      .returning({ id: sessions.id });
    return updated.length === 1 ? 'cancellation_requested' : 'already_terminal';
  });
}

/** Release the per-connection lock only after the caller has fenced the worker. */
export async function finalizeSessionCancellation(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(sessions)
    .set({
      status: 'cancelled',
      error: null,
      completedAt: new Date(),
    })
    .where(and(eq(sessions.id, id), eq(sessions.status, 'cancelling')))
    .returning({ id: sessions.id });
  return updated.length === 1;
}

/**
 * Publish a failed outcome only after the caller has positively fenced the old
 * execution. `cancelling` keeps the per-connection lock held until this write.
 */
export async function finalizeSessionFailureAfterFence(
  db: Db,
  id: string,
  error: string,
): Promise<boolean> {
  const updated = await db
    .update(sessions)
    .set({
      status: 'failed',
      error,
      failureReason: 'instance_died',
      completedAt: new Date(),
    })
    .where(and(eq(sessions.id, id), eq(sessions.status, 'cancelling')))
    .returning({ id: sessions.id });
  return updated.length === 1;
}
