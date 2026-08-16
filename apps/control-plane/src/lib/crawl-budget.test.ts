import { describe, it, expect } from 'vitest';
import {
  MAX_CRAWL_SECONDS, CRAWL_DISPATCH_GRACE_SECONDS, CRAWL_EXPIRE_SECONDS, DEFAULT_LEASE_MS,
} from './crawl-budget';

describe('crawl budget invariants', () => {
  it('caps a single crawl at 30 minutes (the institution timeoutSeconds ceiling)', () => {
    expect(MAX_CRAWL_SECONDS).toBe(30 * 60);
  });

  it('the per-connection lock LEASE outlives the crawl wall-clock — the C2 invariant', () => {
    // If the lease could expire while a crawl is still legitimately running, the stale-session reaper (fires
    // on stale-heartbeat AND expired-lease) could false-reap a LIVE crawl during a transient heartbeat gap,
    // releasing its lock so a second crawl races it. The lease MUST be >= the full max wall-clock.
    expect(CRAWL_EXPIRE_SECONDS).toBe(MAX_CRAWL_SECONDS + CRAWL_DISPATCH_GRACE_SECONDS);
    expect(DEFAULT_LEASE_MS).toBeGreaterThanOrEqual(CRAWL_EXPIRE_SECONDS * 1000);
  });
});
