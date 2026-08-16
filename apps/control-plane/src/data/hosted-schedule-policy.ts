/**
 * When a scheduled crawl runs next, and how a due occurrence is handed over exactly once.
 *
 * Two separate things live here. The first is the backoff policy: a connection that cannot currently be
 * crawled is not retried on its usual cadence, and one whose credentials look wrong is not hammered at all.
 * The second is the hand-over protocol, which exists because scheduling is durable: a successor occurrence
 * has to be committed and armed BEFORE its predecessor is allowed to authorise a crawl, or a wake-up
 * arriving in the gap would find no record of itself and be lost.
 *
 * Both are product policy. Pure: plain values in, a verdict out; times are epoch milliseconds.
 */
import { isRecoverableConnectionStatus } from './crawl-status';
import type { CrawlFailureReason } from '@accrawl/contracts';
import {
  MAX_CONSECUTIVE_CRAWL_FAILURES,
  isAuthCrawlFailureReason,
} from './crawl-bookkeeping';

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;

/** A connection that cannot be crawled right now is looked at again tomorrow rather than on its cadence. */
export const UNRECOVERABLE_RETRY_MS = DAY_MS;
/** Credentials that look wrong are retried daily; anything else that keeps failing waits a week. */
export const AUTH_FAILURE_BACKOFF_MS = DAY_MS;
export const REPEATED_FAILURE_BACKOFF_MS = WEEK_MS;

/** What the policy needs to know about a connection to place its next occurrence. */
export interface ScheduledConnectionFacts {
  status: string;
  consecutiveFailures: number;
  lastFailureReason?: CrawlFailureReason | null;
  crawlSchedule: string;
  crawlTimezone: string;
}

export interface NextOccurrence {
  nextCrawlAtMs: number;
  /** False when the occurrence only moves the schedule forward without running a crawl. */
  shouldDispatch: boolean;
}

/**
 * Where the next occurrence falls, and whether this one may actually run.
 *
 * `nextRunFromCron` is injected rather than imported so this stays free of the scheduling clock and can be
 * exercised directly; the caller passes the product's own cron evaluation.
 */
export function planNextOccurrence(
  connection: ScheduledConnectionFacts,
  nowMs: number,
  nextRunFromCron: (schedule: string, timezone: string, from: Date) => Date,
): NextOccurrence {
  if (!isRecoverableConnectionStatus(connection.status)) {
    return { nextCrawlAtMs: nowMs + UNRECOVERABLE_RETRY_MS, shouldDispatch: false };
  }
  if (connection.consecutiveFailures > MAX_CONSECUTIVE_CRAWL_FAILURES) {
    return {
      nextCrawlAtMs: nowMs + (
        isAuthCrawlFailureReason(connection.lastFailureReason)
          ? AUTH_FAILURE_BACKOFF_MS
          : REPEATED_FAILURE_BACKOFF_MS
      ),
      shouldDispatch: false,
    };
  }
  return {
    nextCrawlAtMs: nextRunFromCron(
      connection.crawlSchedule,
      connection.crawlTimezone,
      new Date(nowMs),
    ).getTime(),
    shouldDispatch: true,
  };
}

/** The durable outbox record for a connection's next occurrence. Times are epoch milliseconds. */
export interface DueRecordFacts {
  scheduleRevision: number;
  nextCrawlAtMs?: number;
  taskArmed?: boolean;
  pendingOccurrenceAtMs?: number | null;
  pendingOccurrenceShouldDispatch?: boolean;
}

/** What the policy needs about the connection itself when judging a claim. */
export interface ScheduleClaimFacts {
  deleted: boolean;
  scheduleEnabled: boolean;
  scheduleRevision: number;
}

export type ScheduleAdvanceDecision =
  /** The claim no longer matches the schedule; drop it. */
  | { kind: 'stale' }
  /** The successor exists but is not armed yet; the caller should come back. */
  | { kind: 'pending' }
  /** A previous run already advanced the schedule; consume the marker it left. */
  | { kind: 'finished'; shouldDispatch: boolean }
  /** This caller advances the schedule and must arm the successor before dispatching. */
  | { kind: 'advanced'; next: NextOccurrence };

export interface ScheduleAdvanceInput {
  claimedDueAtMs: number;
  taskScheduleRevision: number;
  connection: ScheduleClaimFacts | null;
  due: DueRecordFacts | null;
  /** Computed by planNextOccurrence; passed in so this stays a pure verdict over facts. */
  plan: () => NextOccurrence;
}

/**
 * Whether this claim owns the due occurrence, and what to do with it.
 *
 * The `pending` case is the heart of the protocol: seeing a pending occurrence equal to the claim means a
 * previous run already committed the successor. If that successor is not yet armed, the caller must retry
 * rather than dispatch, because dispatching first would let a crash lose the successor entirely.
 */
export function decideScheduleAdvance(
  input: ScheduleAdvanceInput,
): ScheduleAdvanceDecision {
  const { connection, due } = input;
  if (!connection || !due) return { kind: 'stale' };
  if (
    connection.deleted
    || !connection.scheduleEnabled
    || connection.scheduleRevision !== input.taskScheduleRevision
    || due.scheduleRevision !== input.taskScheduleRevision
  ) {
    return { kind: 'stale' };
  }

  if (due.pendingOccurrenceAtMs != null
    && due.pendingOccurrenceAtMs === input.claimedDueAtMs) {
    if (due.taskArmed !== true) return { kind: 'pending' };
    return {
      kind: 'finished',
      shouldDispatch: due.pendingOccurrenceShouldDispatch === true,
    };
  }

  if (
    due.pendingOccurrenceAtMs != null
    || due.taskArmed === false
    || due.nextCrawlAtMs !== input.claimedDueAtMs
  ) {
    return { kind: 'stale' };
  }

  return { kind: 'advanced', next: input.plan() };
}

/**
 * Whether the predecessor may now authorise its crawl, once its successor has been armed. Consuming the
 * marker is what makes a duplicate wake-up unable to dispatch a second time.
 */
export function decideScheduleConsume(
  input: Omit<ScheduleAdvanceInput, 'plan'>,
): 'dispatch' | 'advanced_without_dispatch' | 'stale' {
  const { connection, due } = input;
  if (!connection || !due) return 'stale';
  if (
    connection.deleted
    || !connection.scheduleEnabled
    || connection.scheduleRevision !== input.taskScheduleRevision
    || due.scheduleRevision !== input.taskScheduleRevision
    || due.taskArmed !== true
    || due.pendingOccurrenceAtMs !== input.claimedDueAtMs
  ) {
    return 'stale';
  }
  return due.pendingOccurrenceShouldDispatch === true
    ? 'dispatch'
    : 'advanced_without_dispatch';
}
