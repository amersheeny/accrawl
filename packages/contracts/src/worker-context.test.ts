import { describe, expect, it } from 'vitest';
import { CrawlRequestSchema, workerContextOf } from './schemas';

const CONTEXT = {
  namespace: 'production',
  runtimePartitionId: 'a-partition',
  attemptId: '00000000-0000-4000-8000-000000000001',
};

const REQUEST = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  loginUrl: 'https://bank.example/login',
  username: 'someone',
  password: 'secret',
  requires2fa: false,
  maxSteps: 40,
  timeoutSeconds: 600,
};

describe('the worker routing context across a rename', () => {
  it('reads the name a sender that predates the rename still uses', () => {
    // A release updates workers before the control plane, so for one release this is the only name
    // arriving. Dropping it early would strand every crawl dispatched in that window.
    expect(workerContextOf({ firestoreWorker: CONTEXT })).toEqual(CONTEXT);
  });

  it('reads the name senders use once they are updated', () => {
    expect(workerContextOf({ workerContext: CONTEXT })).toEqual(CONTEXT);
  });

  it('prefers the current name when a sender emits both', () => {
    const older = { ...CONTEXT, attemptId: '00000000-0000-4000-8000-000000000002' };
    expect(workerContextOf({ workerContext: CONTEXT, firestoreWorker: older })).toEqual(CONTEXT);
  });

  it('reports nothing when a request carries neither', () => {
    expect(workerContextOf({})).toBeUndefined();
  });

  it('accepts either name over the wire, and rejects a malformed one under both', () => {
    expect(CrawlRequestSchema.safeParse({ ...REQUEST, workerContext: CONTEXT }).success).toBe(true);
    expect(CrawlRequestSchema.safeParse({ ...REQUEST, firestoreWorker: CONTEXT }).success).toBe(true);

    const malformed = { ...CONTEXT, attemptId: 'not-a-uuid' };
    expect(CrawlRequestSchema.safeParse({ ...REQUEST, workerContext: malformed }).success).toBe(false);
    expect(CrawlRequestSchema.safeParse({ ...REQUEST, firestoreWorker: malformed }).success).toBe(false);
  });
});
