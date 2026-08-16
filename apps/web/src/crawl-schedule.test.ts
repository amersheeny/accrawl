import { describe, expect, it } from 'vitest';
import type { Connection } from './api';
import {
  formatSchedule,
  scheduleFormFromConnection,
  schedulePatch,
} from './crawl-schedule';

const connection = (patch: Partial<Connection> = {}): Connection => ({
  id: 'connection-1',
  institutionId: 'bank',
  status: 'connected',
  loginDomainVerified: true,
  nickname: null,
  crawlScheduleEnabled: true,
  crawlSchedule: '0 6 * * *',
  crawlTimezone: 'Europe/London',
  nextCrawlAt: '2026-08-02T05:00:00.000Z',
  consecutiveFailures: 0,
  safeErrorMessage: null,
  crawlStats: {
    totalCount: 0,
    completedCount: 0,
    failedCount: 0,
    consecutiveFailures: 0,
    avgCostUsd: 0,
    recentCosts: [],
  },
  updatedAt: '2026-08-01T12:00:00.000Z',
  ...patch,
});

describe('crawl schedule controls', () => {
  it('round-trips daily, weekly, monthly, and last-day schedules', () => {
    for (const [cron, expected] of [
      ['5 7 * * *', 'Daily at 07:05'],
      ['30 8 * * 2', 'Weekly on Tuesday at 08:30'],
      ['45 9 14 * *', 'Monthly on day 14 at 09:45'],
      ['0 6 L * *', 'Monthly on the last day at 06:00'],
    ] as const) {
      const item = connection({ crawlSchedule: cron });
      const form = scheduleFormFromConnection(item);
      expect(schedulePatch(form)?.crawlSchedule).toBe(cron);
      expect(formatSchedule(item)).toBe(expected);
    }
  });

  it('preserves unsupported existing cron until the operator selects a supported frequency', () => {
    const form = scheduleFormFromConnection(connection({ crawlSchedule: '*/5 * * * *' }));
    expect(form.frequency).toBe('custom');
    expect(schedulePatch(form)).toBeNull();
  });

  it('turns manual-only mode off without rewriting the saved recurrence', () => {
    const form = scheduleFormFromConnection(connection({ crawlScheduleEnabled: false }));
    expect(form.frequency).toBe('manual');
    const patch = schedulePatch(form);
    expect(patch).toEqual({
      crawlScheduleEnabled: false,
      crawlTimezone: 'Europe/London',
    });
  });
});
