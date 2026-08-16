import { describe, expect, it } from 'vitest';
import {
  AUTH_FAILURE_BACKOFF_MS,
  REPEATED_FAILURE_BACKOFF_MS,
  UNRECOVERABLE_RETRY_MS,
  decideScheduleAdvance,
  decideScheduleConsume,
  planNextOccurrence,
} from './hosted-schedule-policy';

const NOW = 1_700_000_000_000;
const DUE = 1_700_000_500_000;
const CRON_NEXT = new Date(NOW + 3_600_000);
const cron = (): Date => CRON_NEXT;

const healthy = {
  status: 'connected',
  consecutiveFailures: 0,
  crawlSchedule: '0 3 * * *',
  crawlTimezone: 'UTC',
};

describe('placing the next scheduled occurrence', () => {
  it('follows the cadence while the connection can be crawled', () => {
    expect(planNextOccurrence(healthy, NOW, cron)).toEqual({
      nextCrawlAtMs: CRON_NEXT.getTime(),
      shouldDispatch: true,
    });
  });

  it('looks again tomorrow, without crawling, when the connection cannot be crawled at all', () => {
    expect(planNextOccurrence({ ...healthy, status: 'disconnected' }, NOW, cron)).toEqual({
      nextCrawlAtMs: NOW + UNRECOVERABLE_RETRY_MS,
      shouldDispatch: false,
    });
  });

  it('backs off a day on bad credentials and a week on anything else that keeps failing', () => {
    // Retrying wrong credentials on the usual cadence is how an account gets locked out.
    expect(planNextOccurrence({
      ...healthy,
      consecutiveFailures: 99,
      lastFailureReason: 'bank_login_failed',
    }, NOW, cron)).toEqual({
      nextCrawlAtMs: NOW + AUTH_FAILURE_BACKOFF_MS,
      shouldDispatch: false,
    });
    expect(planNextOccurrence({
      ...healthy,
      consecutiveFailures: 99,
      lastFailureReason: 'navigation_timeout',
    }, NOW, cron)).toEqual({
      nextCrawlAtMs: NOW + REPEATED_FAILURE_BACKOFF_MS,
      shouldDispatch: false,
    });
  });
});

describe('handing a due occurrence over exactly once', () => {
  const connection = { deleted: false, scheduleEnabled: true, scheduleRevision: 7 };
  const claim = { claimedDueAtMs: DUE, taskScheduleRevision: 7 };
  const plan = () => ({ nextCrawlAtMs: CRON_NEXT.getTime(), shouldDispatch: true });

  it('advances the schedule when this claim is the current occurrence', () => {
    expect(decideScheduleAdvance({
      ...claim,
      connection,
      due: { scheduleRevision: 7, nextCrawlAtMs: DUE, taskArmed: true },
      plan,
    })).toEqual({ kind: 'advanced', next: plan() });
  });

  /**
   * The heart of the protocol: a successor already exists but is not armed. Dispatching now would let a
   * crash lose the successor entirely, so the caller must come back instead.
   */
  it('asks the caller to retry while the successor is committed but unarmed', () => {
    expect(decideScheduleAdvance({
      ...claim,
      connection,
      due: { scheduleRevision: 7, nextCrawlAtMs: DUE, taskArmed: false, pendingOccurrenceAtMs: DUE },
      plan,
    })).toEqual({ kind: 'pending' });
  });

  it('consumes the marker a previous run left once the successor is armed', () => {
    expect(decideScheduleAdvance({
      ...claim,
      connection,
      due: {
        scheduleRevision: 7,
        nextCrawlAtMs: DUE,
        taskArmed: true,
        pendingOccurrenceAtMs: DUE,
        pendingOccurrenceShouldDispatch: true,
      },
      plan,
    })).toEqual({ kind: 'finished', shouldDispatch: true });
  });

  it('drops a claim whose schedule was edited, disabled or deleted underneath it', () => {
    const due = { scheduleRevision: 7, nextCrawlAtMs: DUE, taskArmed: true };
    expect(decideScheduleAdvance({ ...claim, connection: { ...connection, deleted: true }, due, plan }))
      .toEqual({ kind: 'stale' });
    expect(decideScheduleAdvance({ ...claim, connection: { ...connection, scheduleEnabled: false }, due, plan }))
      .toEqual({ kind: 'stale' });
    expect(decideScheduleAdvance({ ...claim, connection: { ...connection, scheduleRevision: 8 }, due, plan }))
      .toEqual({ kind: 'stale' });
    expect(decideScheduleAdvance({ ...claim, connection, due: { ...due, nextCrawlAtMs: DUE + 1 }, plan }))
      .toEqual({ kind: 'stale' });
  });

  it('authorises the crawl only for the armed occurrence it claimed', () => {
    expect(decideScheduleConsume({
      ...claim,
      connection,
      due: {
        scheduleRevision: 7,
        taskArmed: true,
        pendingOccurrenceAtMs: DUE,
        pendingOccurrenceShouldDispatch: true,
      },
    })).toBe('dispatch');
    expect(decideScheduleConsume({
      ...claim,
      connection,
      due: {
        scheduleRevision: 7,
        taskArmed: true,
        pendingOccurrenceAtMs: DUE,
        pendingOccurrenceShouldDispatch: false,
      },
    })).toBe('advanced_without_dispatch');
    // A duplicate wake-up arriving after the marker was consumed must not dispatch a second crawl.
    expect(decideScheduleConsume({
      ...claim,
      connection,
      due: { scheduleRevision: 7, taskArmed: true, pendingOccurrenceAtMs: null },
    })).toBe('stale');
  });
});
