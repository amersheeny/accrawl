/**
 * Completion bookkeeping: fold a finished crawl into the connection's status + crawlStats.
 *
 * On success the connection is 'connected', the failure streak resets, and the watermark
 * (lastSuccessfulTxCrawlDay) advances to the CRAWL DAY (today). Its presence selects the later-crawl
 * branch; the next cutoff is always the current UTC date minus seven calendar days, regardless of the
 * stored watermark date or legacy institution lookback. A successful crawl completes every supported
 * financial-data surface, including a legitimately empty transaction window. Invalid or identity-dropped
 * transaction observations block the watermark so the first-crawl 90-day branch is revisited. On failure
 * the connection is 'error' and the consecutive-failure
 * streak increments. Past MAX_CONSECUTIVE_CRAWL_FAILURES, only a classified rejected-credentials
 * failure enters needs_reauth; persistent non-auth failures remain operator-actionable errors and the
 * scheduler backs them off to weekly retries.
 *
 * consecutiveFailures lives both on a top-level column (indexed, for the scheduler's due-query) and in
 * crawlStats (for the full picture); both are kept in lock-step here.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections, type CrawlStats } from '../db/schema';
import type { CrawlFailureReason } from '@accrawl/contracts';

export const MAX_CONSECUTIVE_CRAWL_FAILURES = 5;
const RECENT_COSTS_CAP = 20;
const AUTH_FAILURE_REASONS: ReadonlySet<CrawlFailureReason> = new Set(['bank_login_failed']);

export function isAuthCrawlFailureReason(
  reason: CrawlFailureReason | undefined | null,
): boolean {
  return reason !== undefined && reason !== null && AUTH_FAILURE_REASONS.has(reason);
}

/**
 * Failures that say nothing about the connection itself, and are worth trying
 * again before the next scheduled occurrence.
 *
 * A crawl that fails because the owner's phone was asleep, the bank was closed,
 * or a page timed out has learned nothing — the connection is fine, and the next
 * occurrence is a whole cron period away. Waiting that long is how a connection
 * that fails at 06:00 every night silently never refreshes. That is not
 * hypothetical: on 2026-08-11 a scheduled crawl failed at 09:56 with "OTP relay
 * did not come online" and the next attempt was the following morning.
 *
 * Deliberately excluded, because retrying each is worse than waiting:
 *   bank_login_failed   the credentials are wrong. Retrying risks locking the
 *                       account at the bank; escalation to needs_reauth is the
 *                       correct response and already exists.
 *   waf_block           the site already decided we look like a bot. Returning
 *                       immediately confirms it.
 *   api_contract_drift  our code is out of step with the provider. No number of
 *                       retries fixes that.
 */
const TRANSIENT_FAILURE_REASONS: ReadonlySet<CrawlFailureReason> = new Set([
  'otp_relay_unreachable',
  'otp_timeout',
  'outside_hours',
  'site_unavailable',
  'instance_died',
  'page_capture_timeout',
  'navigation_timeout',
  'crawl_watchdog',
]);

/**
 * Backoff per consecutive failure. Each attempt is a real bank login, a 2FA
 * prompt to the owner's phone, and a few dollars of model tokens — a measured
 * crawl cost $2.64 — so the ceiling matters as much as the floor. After the
 * last step the configured schedule takes over again rather than retrying
 * forever.
 */
const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [
  30 * 60 * 1_000,
  2 * 60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
];

/**
 * How long to wait before retrying a failed crawl ahead of its next scheduled
 * occurrence, or null to leave the schedule alone.
 *
 * `consecutiveFailures` is the count AFTER this failure, as returned by
 * crawlStatsAfterFailure.
 */
export function transientRetryDelayMs(
  reason: CrawlFailureReason | undefined | null,
  consecutiveFailures: number,
): number | null {
  if (reason == null || !TRANSIENT_FAILURE_REASONS.has(reason)) return null;
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 1) return null;
  return TRANSIENT_RETRY_DELAYS_MS[consecutiveFailures - 1] ?? null;
}

export const EMPTY_CRAWL_STATS: CrawlStats = {
  totalCount: 0, completedCount: 0, failedCount: 0, consecutiveFailures: 0, avgCostUsd: 0, recentCosts: [],
};

/** Newest-first recentCosts (capped) + the avg over that window; a non-positive cost leaves both as-is. */
function withCost(stats: CrawlStats, costUsd?: number): Pick<CrawlStats, 'recentCosts' | 'avgCostUsd'> {
  if (costUsd === undefined || costUsd <= 0) return { recentCosts: stats.recentCosts, avgCostUsd: stats.avgCostUsd };
  const recentCosts = [costUsd, ...stats.recentCosts].slice(0, RECENT_COSTS_CAP);
  return { recentCosts, avgCostUsd: recentCosts.reduce((a, b) => a + b, 0) / recentCosts.length };
}

export interface CrawlSuccessInput {
  crawlMemory?: string;
  costUsd?: number;
  today?: Date;
  /** How many extracted transactions were rejected as invalid or lacked a
   * safe identity. A nonzero value keeps the prior watermark. */
  transactionsRejected?: number;
}

/** Storage-neutral success transition, shared by every backend. */
export function crawlStatsAfterSuccess(
  current: CrawlStats | null | undefined,
  input: CrawlSuccessInput,
): CrawlStats {
  const stats = current ?? EMPTY_CRAWL_STATS;
  const today = (input.today ?? new Date()).toISOString().split('T')[0];
  const cleanTxExtraction = (input.transactionsRejected ?? 0) === 0;
  const advanceWatermark = cleanTxExtraction;
  return {
    ...stats,
    totalCount: stats.totalCount + 1,
    completedCount: stats.completedCount + 1,
    consecutiveFailures: 0,
    lastFailureReason: undefined,
    ...(advanceWatermark ? { lastSuccessfulTxCrawlDay: today } : {}),
    ...withCost(stats, input.costUsd),
  };
}

export async function applyCrawlSuccess(db: Db, connectionId: string, input: CrawlSuccessInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [conn] = await tx.select({ crawlStats: connections.crawlStats }).from(connections).where(eq(connections.id, connectionId)).limit(1);
    if (!conn) return;
    const next = crawlStatsAfterSuccess(conn.crawlStats, input);
    await tx
      .update(connections)
      .set({
        status: 'connected',
        consecutiveFailures: 0,
        safeErrorMessage: null,
        crawlStats: next,
        ...(input.crawlMemory ? { crawlMemory: input.crawlMemory } : {}),
        updatedAt: new Date(),
      })
      // Never resurrect a connection the operator disconnected: if it was set to 'disabled' while this
      // crawl was in flight, a completing success must not flip it back to 'connected'.
      .where(and(eq(connections.id, connectionId), ne(connections.status, 'disabled')));
  });
}

export interface CrawlFailureInput {
  error: string;
  failureReason?: CrawlFailureReason;
  costUsd?: number;
}

export interface CrawlFailureTransition {
  consecutiveFailures: number;
  crawlStats: CrawlStats;
  status: 'error' | 'needs_reauth';
}

/** Storage-neutral failure transition, shared by every backend. */
export function crawlStatsAfterFailure(
  current: CrawlStats | null | undefined,
  currentConsecutiveFailures: number | null | undefined,
  input: CrawlFailureInput,
): CrawlFailureTransition {
  const stats = current ?? EMPTY_CRAWL_STATS;
  const consecutiveFailures = (currentConsecutiveFailures ?? 0) + 1;
  const crawlStats: CrawlStats = {
    ...stats,
    totalCount: stats.totalCount + 1,
    failedCount: stats.failedCount + 1,
    consecutiveFailures,
    lastFailureReason: input.failureReason,
    ...withCost(stats, input.costUsd),
  };
  const status = consecutiveFailures > MAX_CONSECUTIVE_CRAWL_FAILURES
    && isAuthCrawlFailureReason(input.failureReason)
    ? 'needs_reauth'
    : 'error';
  return { consecutiveFailures, crawlStats, status };
}

/** Returns the new consecutive-failure count so the caller/scheduler can decide on escalation. */
export async function applyCrawlFailure(db: Db, connectionId: string, input: CrawlFailureInput): Promise<{ consecutiveFailures: number }> {
  return db.transaction(async (tx) => {
    const [conn] = await tx
      .select({ crawlStats: connections.crawlStats, consecutiveFailures: connections.consecutiveFailures })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    if (!conn) return { consecutiveFailures: 0 };
    const {
      consecutiveFailures,
      crawlStats: next,
      status,
    } = crawlStatsAfterFailure(
      conn.crawlStats,
      conn.consecutiveFailures,
      input,
    );
    await tx
      .update(connections)
      .set({
        status,
        consecutiveFailures,
        safeErrorMessage: input.error.slice(0, 500),
        crawlStats: next,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId));
    return { consecutiveFailures };
  });
}
