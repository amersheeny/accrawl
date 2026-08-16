/**
 * Transaction extraction window derivation for any engine-side request path.
 * Keep this branch contract identical to the control plane: the first
 * successful-history branch receives 90 UTC calendar days; every later branch
 * receives the preceding seven UTC calendar days.
 */

export const MAX_TRANSACTION_WINDOW_DAYS = 90;
export const RECENT_TRANSACTION_WINDOW_DAYS = 7;

/** Subtract `days` from a YYYY-MM-DD date string, in UTC, returning YYYY-MM-DD. */
function subtractDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

/**
 * Derive the inclusive UTC booking-date floor. The watermark is a branch marker
 * only: absent means the first 90-day crawl; present means a later seven-day
 * crawl. Its date value, stored rows, and legacy lookback configuration never
 * move the requested window.
 */
export function deriveTransactionCutoffDate(opts: {
  /** Present after any successful transaction crawl; its value is not an anchor. */
  lastSuccessfulCrawlDay?: string;
  /** Legacy input retained for call-site compatibility; deliberately ignored. */
  newestStoredBookingDate?: string;
  /** Legacy input retained for call-site compatibility; deliberately ignored. */
  lookbackDays?: number;
  /** Test seam: treat this as "now". */
  today?: Date;
}): string {
  const todayBase = opts.today ? new Date(opts.today.getTime()) : new Date();
  const todayUtc = todayBase.toISOString().split('T')[0];
  return subtractDaysUtc(
    todayUtc,
    opts.lastSuccessfulCrawlDay
      ? RECENT_TRANSACTION_WINDOW_DAYS
      : MAX_TRANSACTION_WINDOW_DAYS,
  );
}
