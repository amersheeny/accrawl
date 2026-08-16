import { CronExpressionParser } from 'cron-parser';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CRAWL_SCHEDULE = '0 6 * * *';
export const DEFAULT_CRAWL_TIMEZONE = 'UTC';

/** Intl and cron-parser share the runtime's IANA timezone database. */
export function isValidCrawlTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isValidCrawlSchedule(
  crawlSchedule: string,
  crawlTimezone: string,
): boolean {
  if (!crawlSchedule || crawlSchedule.length > 120 || !isValidCrawlTimezone(crawlTimezone)) {
    return false;
  }
  try {
    CronExpressionParser.parse(crawlSchedule, {
      currentDate: new Date(),
      tz: crawlTimezone,
    }).next();
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next absolute run from a cron expressed in an IANA timezone.
 * Malformed persisted input falls back to +24h so one legacy/out-of-band row
 * cannot wedge the rest of a scheduler sweep. HTTP writes reject it earlier.
 */
export function nextRunFromCron(
  crawlSchedule: string,
  crawlTimezone: string,
  now: Date,
): Date {
  try {
    return CronExpressionParser.parse(crawlSchedule, {
      currentDate: now,
      tz: isValidCrawlTimezone(crawlTimezone)
        ? crawlTimezone
        : DEFAULT_CRAWL_TIMEZONE,
    }).next().toDate();
  } catch {
    return new Date(now.getTime() + DAY_MS);
  }
}
