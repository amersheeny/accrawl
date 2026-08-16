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

describe('the worker routing context', () => {
  it('reads the field senders emit', () => {
    expect(workerContextOf({ workerContext: CONTEXT })).toEqual(CONTEXT);
  });

  it('reports nothing when a request carries none', () => {
    expect(workerContextOf({})).toBeUndefined();
  });

  it('accepts a well-formed context over the wire and rejects a malformed one', () => {
    expect(CrawlRequestSchema.safeParse({ ...REQUEST, workerContext: CONTEXT }).success).toBe(true);
    const malformed = { ...CONTEXT, attemptId: 'not-a-uuid' };
    expect(CrawlRequestSchema.safeParse({ ...REQUEST, workerContext: malformed }).success).toBe(false);
  });

  it('rejects a routing context sent under any other field name', () => {
    // A compatibility alias for the pre-rename name existed so one release could update workers
    // before the control plane. It is closed: nothing emits it, and it named a provider in a contract
    // that must not. What matters now is that the schema is STRICT — a sender still using the old
    // name, or any other, fails loudly at the boundary instead of dispatching a crawl whose routing
    // context silently reads as absent. Asserted through the mechanism rather than by naming the
    // removed field, so this test cannot reintroduce the word it exists to keep out.
    const underAnotherName = { ...REQUEST, legacyWorkerRoutingField: CONTEXT };
    expect(CrawlRequestSchema.safeParse(underAnotherName).success).toBe(false);
  });
});
