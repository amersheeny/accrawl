import { describe, expect, it } from 'vitest';
import type { CrawlFailureReason } from '@accrawl/contracts';
import { transientRetryDelayMs } from './crawl-bookkeeping';

/**
 * Before this policy existed, every failed crawl waited for its next cron
 * occurrence — a full day on the default `0 6 * * *`. A connection whose owner's
 * phone is asleep at 06:00 therefore never refreshed, and nothing said so: the
 * crawl failed quietly and the next attempt was 24 hours away.
 *
 * The policy has to cut in exactly one direction. Retrying a wrong-credentials
 * failure risks locking the account at the bank, and retrying a WAF block
 * confirms the bot suspicion that caused it, so those must keep waiting. The
 * tests below pin both halves, because a policy that retries everything is a
 * worse bug than the one it replaces.
 */
const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;

const TRANSIENT: readonly CrawlFailureReason[] = [
  'otp_relay_unreachable',
  'otp_timeout',
  'outside_hours',
  'site_unavailable',
  'instance_died',
  'page_capture_timeout',
  'navigation_timeout',
  'crawl_watchdog',
];

const MUST_NOT_RETRY: readonly CrawlFailureReason[] = [
  'bank_login_failed',
  'waf_block',
  'api_contract_drift',
  'internal_error',
];

describe('transientRetryDelayMs', () => {
  it.each(TRANSIENT)('retries %s ahead of the next occurrence', (reason) => {
    expect(transientRetryDelayMs(reason, 1)).toBe(30 * MINUTE);
  });

  it.each(MUST_NOT_RETRY)('never brings %s forward', (reason) => {
    for (const failures of [1, 2, 3, 4, 5, 6]) {
      expect(transientRetryDelayMs(reason, failures)).toBeNull();
    }
  });

  it('backs off as the failures repeat, then hands back to the schedule', () => {
    const reason: CrawlFailureReason = 'otp_relay_unreachable';
    expect(transientRetryDelayMs(reason, 1)).toBe(30 * MINUTE);
    expect(transientRetryDelayMs(reason, 2)).toBe(2 * HOUR);
    expect(transientRetryDelayMs(reason, 3)).toBe(6 * HOUR);
    // A connection failing this persistently is not going to be fixed by trying
    // sooner, and every attempt costs a bank login, a 2FA prompt and real money.
    expect(transientRetryDelayMs(reason, 4)).toBeNull();
    expect(transientRetryDelayMs(reason, 9)).toBeNull();
  });

  it('is strictly increasing, so a retry never lands sooner than the one before', () => {
    const reason: CrawlFailureReason = 'otp_timeout';
    const delays = [1, 2, 3].map((n) => transientRetryDelayMs(reason, n));
    expect(delays.every((d) => typeof d === 'number')).toBe(true);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('treats a missing or nonsensical failure count as no retry', () => {
    const reason: CrawlFailureReason = 'otp_relay_unreachable';
    expect(transientRetryDelayMs(reason, 0)).toBeNull();
    expect(transientRetryDelayMs(reason, -1)).toBeNull();
    expect(transientRetryDelayMs(reason, 1.5)).toBeNull();
    expect(transientRetryDelayMs(undefined, 1)).toBeNull();
    expect(transientRetryDelayMs(null, 1)).toBeNull();
  });

  it('never returns a delay longer than the default daily schedule', () => {
    // A "retry sooner" that lands later than the next scheduled occurrence
    // would delay the crawl rather than hasten it, which is the opposite of
    // the point.
    const reason: CrawlFailureReason = 'site_unavailable';
    for (const failures of [1, 2, 3]) {
      expect(transientRetryDelayMs(reason, failures)!).toBeLessThan(24 * HOUR);
    }
  });
});
