import { describe, expect, it } from 'vitest';
import {
  DISPATCH_LEASE_MS,
  DispatchJobMismatchError,
  MAX_DISPATCH_ATTEMPTS,
  decideDispatchReservation,
  type DispatchReservationInput,
} from './hosted-dispatch-decisions';

const SESSION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const NOW = 1_700_000_000_000;

const reservation = (
  overrides: Partial<DispatchReservationInput> = {},
): DispatchReservationInput => ({
  sessionId: SESSION,
  hasEncryptedPayload: true,
  session: { status: 'starting', expectedWorkerAttemptId: ATTEMPT },
  job: null,
  nowMs: NOW,
  owner: 'owner-1',
  ...overrides,
});

describe('deciding whether a crawl may be handed to a worker', () => {
  it('creates the durable record for a first hand-off', () => {
    expect(decideDispatchReservation(reservation())).toEqual({
      outcome: 'dispatch',
      attemptId: ATTEMPT,
      owner: 'owner-1',
      write: {
        kind: 'create',
        attempts: 1,
        leaseExpiresAtMs: NOW + DISPATCH_LEASE_MS,
        expiresAtMs: expect.any(Number),
      },
    });
  });

  it('refuses to hand over a crawl the session has moved past', () => {
    expect(decideDispatchReservation(reservation({
      session: { status: 'completed', expectedWorkerAttemptId: ATTEMPT },
    }))).toEqual({ outcome: 'cancelled' });
    expect(decideDispatchReservation(reservation({
      session: { status: 'starting', expectedWorkerAttemptId: ATTEMPT },
      requestedAttemptId: '33333333-3333-4333-8333-333333333333',
    }))).toEqual({ outcome: 'cancelled' });
  });

  it('treats a live hand-off as already dispatched rather than sending a second one', () => {
    expect(decideDispatchReservation(reservation({
      job: {
        sessionId: SESSION,
        expectedAttemptId: ATTEMPT,
        status: 'queued',
        dispatchAttempts: 1,
        dispatchLeaseExpiresAtMs: NOW + 1_000,
      },
    }))).toEqual({ outcome: 'already-dispatched' });
  });

  /**
   * The load-bearing rule. A hand-off whose acknowledgement was lost may already have started a worker, and
   * a second worker on the same credentials can trip the bank's own protections — so an expired lease with
   * the attempt used up fails the crawl instead of trying again.
   */
  it('never spends a second attempt once the first is used up', () => {
    expect(MAX_DISPATCH_ATTEMPTS).toBe(1);
    expect(decideDispatchReservation(reservation({
      job: {
        sessionId: SESSION,
        expectedAttemptId: ATTEMPT,
        status: 'queued',
        dispatchAttempts: MAX_DISPATCH_ATTEMPTS,
        dispatchLeaseExpiresAtMs: NOW - 1,
        claimSecretVersion: 'projects/p/locations/l/secrets/s/versions/1',
      },
    }))).toEqual({
      outcome: 'exhausted',
      claimSecretVersion: 'projects/p/locations/l/secrets/s/versions/1',
    });
  });

  it('stays refused once a hand-off was rejected outright', () => {
    expect(decideDispatchReservation(reservation({
      job: {
        sessionId: SESSION,
        expectedAttemptId: ATTEMPT,
        status: 'queued',
        dispatchOutcome: 'rejected',
      },
    }))).toEqual({ outcome: 'rejected' });
  });

  it('refuses a record that names a different session or attempt', () => {
    expect(() => decideDispatchReservation(reservation({
      job: { sessionId: 'someone-else', expectedAttemptId: ATTEMPT, status: 'queued' },
    }))).toThrow(DispatchJobMismatchError);
  });

  it('has nothing to dispatch without a session or a payload', () => {
    expect(decideDispatchReservation(reservation({ session: null })))
      .toEqual({ outcome: 'missing' });
    expect(decideDispatchReservation(reservation({ hasEncryptedPayload: false })))
      .toEqual({ outcome: 'missing' });
  });
});
