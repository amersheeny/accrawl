/**
 * Project a crawl session row into the retrieval-neutral `SyncView` of the normalized data contract
 * (docs/spec-data-api.md §12.3). A "sync" IS a refresh run; this maps the internal session status and
 * failure taxonomy onto the crawl-free vocabulary the public contract exposes (queued/running/
 * succeeded/failed + authentication_failed/action_required/institution_unavailable/internal_error).
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions } from '../db/schema';
import type { SyncView } from '@accrawl/contracts';

function mapStatus(s: string): SyncView['status'] {
  switch (s) {
    case 'starting': return 'queued';
    case 'completed': return 'succeeded';
    case 'failed':
    case 'cancelled': return 'failed';
    default: return 'running'; // logging_in | navigating | waiting_for_otp | extracting
  }
}

/** Map the internal CrawlFailureReason onto the contract's retrieval-neutral failure set. */
export function mapSyncFailureReason(reason: string | null): SyncView['failureReason'] | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'bank_login_failed':
      return 'authentication_failed';
    case 'otp_timeout':
    case 'otp_relay_unreachable':
      return 'action_required';
    case 'waf_block':
    case 'outside_hours':
    case 'site_unavailable':
    case 'navigation_timeout':
    case 'page_capture_timeout':
      return 'institution_unavailable';
    default:
      return 'internal_error';
  }
}

export async function getSyncView(db: Db, id: string): Promise<SyncView | null> {
  const [row] = await db
    .select({
      id: sessions.id,
      connectionId: sessions.connectionId,
      status: sessions.status,
      startedAt: sessions.startedAt,
      completedAt: sessions.completedAt,
      failureReason: sessions.failureReason,
      syncCounts: sessions.syncCounts,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (!row) return null;
  const status = mapStatus(row.status);
  return {
    id: row.id,
    connectionId: row.connectionId,
    status,
    startedAt: (row.startedAt ?? new Date(0)).toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.syncCounts ? { counts: row.syncCounts } : {}),
    ...(status === 'failed' ? { failureReason: mapSyncFailureReason(row.failureReason) } : {}),
  };
}
