/**
 * When a hosted crawl may be handed to a worker, and what happens when handing it over goes wrong.
 *
 * Starting a worker is not idempotent: once the request leaves, a crawl may be running even if the reply
 * never arrives. So the decision to dispatch is made against a durable record — is this attempt still the
 * one the session expects, is a previous hand-off still in flight, has this crawl already used up its one
 * attempt — and that reasoning is product policy rather than a property of the store holding the record.
 *
 * Pure: plain values in, a verdict and the numbers to write out. Times are epoch milliseconds; a store that
 * keeps its own timestamp type converts at its boundary.
 */
import { ACTIVE_SESSION_STATUSES } from './worker-ownership';

/** How long one hand-off may be in flight before another may be attempted. */
export const DISPATCH_LEASE_MS = 45_000;
/** How long a caller is asked to wait before retrying a crawl that could not be handed over. */
export const DISPATCH_RETRY_AFTER_MS = 120_000;
/** How long the durable job record is kept after the crawl ends. */
export const JOB_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
/**
 * One. A crawl that was dispatched and left no trace is NOT retried automatically: the request may have
 * arrived and started a worker whose acknowledgement was lost, and a second worker on the same credentials
 * could trip the bank's own protections. Recovery is a new attempt with a new record, decided elsewhere.
 */
export const MAX_DISPATCH_ATTEMPTS = 1;

/** Recorded on the job and the session when the one attempt is used up. */
export const DISPATCH_EXHAUSTED_ERROR = 'maximum worker dispatch attempts exhausted';
export const DISPATCH_EXHAUSTED_FAILURE_REASON = 'instance_died';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** What a store reads about the session before a hand-off is considered. */
export interface DispatchSessionFacts {
  status?: string;
  expectedWorkerAttemptId?: string;
}

/** What a store reads about any existing job record. Times are epoch milliseconds. */
export interface DispatchJobFacts {
  sessionId?: string;
  expectedAttemptId?: string;
  status?: string;
  dispatchOutcome?: string;
  dispatchAttempts?: number;
  dispatchLeaseExpiresAtMs?: number;
  claimSecretVersion?: string;
}

/** The writes a store should make to record that this caller now owns the hand-off. */
export interface DispatchReservationWrite {
  kind: 'create' | 'update';
  attempts: number;
  leaseExpiresAtMs: number;
  /** Only for a newly created record. */
  expiresAtMs?: number;
}

export type DispatchReservationDecision =
  /** No session, or nothing to dispatch with. */
  | { outcome: 'missing' }
  /** The session moved on, or this is no longer the attempt it expects. */
  | { outcome: 'cancelled' }
  /** A previous hand-off was refused outright; the crawl is over. */
  | { outcome: 'rejected' }
  /** A worker already has this crawl, or a hand-off is still in flight. */
  | { outcome: 'already-dispatched' }
  /** The one attempt is used up: the caller must fail the job and the session. */
  | { outcome: 'exhausted'; claimSecretVersion?: string }
  /** This caller owns the hand-off. */
  | { outcome: 'dispatch'; attemptId: string; owner: string; write: DispatchReservationWrite };

export interface DispatchReservationInput {
  sessionId: string;
  /** Present when a caller is resuming a specific attempt rather than starting whichever is current. */
  requestedAttemptId?: string;
  /** Absent when the caller holds no payload to create a new record with. */
  hasEncryptedPayload: boolean;
  session: DispatchSessionFacts | null;
  job: DispatchJobFacts | null;
  nowMs: number;
  /** Identifies this hand-off, so a later outcome can be matched to the caller that made it. */
  owner: string;
}

/** Raised when a stored job names a different session or attempt than the one being reserved. */
export class DispatchJobMismatchError extends Error {
  constructor() {
    super('crawl job does not match its reserved session attempt');
    this.name = 'DispatchJobMismatchError';
  }
}

export function decideDispatchReservation(
  input: DispatchReservationInput,
): DispatchReservationDecision {
  const { session, job, nowMs } = input;
  if (!session) return { outcome: 'missing' };
  if (!ACTIVE_SESSION_STATUSES.has(String(session.status ?? ''))) {
    return { outcome: 'cancelled' };
  }

  const attemptId = String(session.expectedWorkerAttemptId ?? '');
  if (
    !SESSION_ID.test(attemptId)
    || (input.requestedAttemptId !== undefined && attemptId !== input.requestedAttemptId)
  ) {
    return { outcome: 'cancelled' };
  }

  if (job) {
    if (job.sessionId !== input.sessionId || job.expectedAttemptId !== attemptId) {
      throw new DispatchJobMismatchError();
    }
    if (job.dispatchOutcome === 'rejected' || job.status === 'failed') {
      return { outcome: 'rejected' };
    }
    if (
      job.status === 'running'
      || job.status === 'succeeded'
      || job.status === 'cancel_requested'
      || job.status === 'cancelled'
    ) {
      return { outcome: 'already-dispatched' };
    }
    const leaseLive = typeof job.dispatchLeaseExpiresAtMs === 'number'
      && job.dispatchLeaseExpiresAtMs > nowMs;
    if (leaseLive) return { outcome: 'already-dispatched' };

    const attempts = job.dispatchAttempts ?? 0;
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      return { outcome: 'exhausted', claimSecretVersion: job.claimSecretVersion };
    }
    return {
      outcome: 'dispatch',
      attemptId,
      owner: input.owner,
      write: {
        kind: 'update',
        attempts: attempts + 1,
        leaseExpiresAtMs: nowMs + DISPATCH_LEASE_MS,
      },
    };
  }

  if (!input.hasEncryptedPayload) return { outcome: 'missing' };
  return {
    outcome: 'dispatch',
    attemptId,
    owner: input.owner,
    write: {
      kind: 'create',
      attempts: 1,
      leaseExpiresAtMs: nowMs + DISPATCH_LEASE_MS,
      expiresAtMs: nowMs + JOB_RETENTION_MS,
    },
  };
}
