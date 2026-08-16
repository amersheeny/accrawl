/**
 * Tests for the exact first/later transaction extraction branches.
 */

import { describe, it, expect } from 'vitest';
import { deriveTransactionCutoffDate } from './transaction-window';

describe('deriveTransactionCutoffDate', () => {
  // Fixed "today" for determinism: 2026-06-12 (midday UTC avoids date-line edges).
  const today = new Date('2026-06-12T12:00:00Z');
  const ninetyDaysAgo = '2026-03-14';

  it('uses the preceding seven UTC calendar days after any successful crawl', () => {
    expect(deriveTransactionCutoffDate({ lastSuccessfulCrawlDay: '2026-06-11', today })).toBe('2026-06-05');
  });

  it('uses the same seven-day window regardless of watermark value', () => {
    expect(deriveTransactionCutoffDate({ lastSuccessfulCrawlDay: '2026-06-12', today })).toBe('2026-06-05');
    expect(deriveTransactionCutoffDate({ lastSuccessfulCrawlDay: '2020-01-01', today })).toBe('2026-06-05');
  });

  it('ignores legacy stored-row and lookback inputs', () => {
    expect(deriveTransactionCutoffDate({
      lastSuccessfulCrawlDay: '2026-06-11',
      newestStoredBookingDate: '2026-04-01',
      lookbackDays: 90,
      today,
    })).toBe('2026-06-05');
    expect(deriveTransactionCutoffDate({
      newestStoredBookingDate: '2026-06-10',
      lookbackDays: 0,
      today,
    })).toBe(ninetyDaysAgo);
  });

  it('neither watermark nor stored tx (first crawl) → backfills the 90-day window', () => {
    expect(deriveTransactionCutoffDate({ today })).toBe(ninetyDaysAgo);
  });

  it('always returns YYYY-MM-DD with a real now()', () => {
    expect(deriveTransactionCutoffDate({})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(deriveTransactionCutoffDate({ lastSuccessfulCrawlDay: '2020-01-01' })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
