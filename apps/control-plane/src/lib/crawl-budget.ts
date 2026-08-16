/**
 * Crawl time budget — the SINGLE SOURCE OF TRUTH for how long a crawl may take, and how the institution
 * timeout ceiling, the pg-boss job expiry, and the per-connection lock lease relate.
 *
 * INVARIANT (the reason this is one dependency-free file): the per-connection lock LEASE must OUTLIVE the
 * crawl's whole WALL-CLOCK (agent-loop deadline + dispatch/store/teardown grace). If the lease can expire
 * while a crawl is still legitimately running, the stale-session reaper (which fires on stale-heartbeat AND
 * expired-lease) can false-reap that LIVE crawl during a transient heartbeat gap — releasing its lock so a
 * second crawl races it (double bank login). We derive the lease FROM the expiry here so it can never drift
 * shorter than the crawl again. (Deliberately no imports — pgboss.ts imports run-crawl.ts, so the shared
 * constants must live somewhere neither depends back into.)
 */

/** Max agent-loop deadline a single crawl may run — the ceiling on institution.timeoutSeconds. */
export const MAX_CRAWL_SECONDS = 1800; // 30 min
/** Maximum time a newly-created hosted Job may wait to claim its payload. */
export const CRAWL_JOB_STARTUP_GRACE_MS = 5 * 60 * 1000;
/** Grace beyond the agent loop for dispatch + extraction store + teardown. */
export const CRAWL_DISPATCH_GRACE_SECONDS = 600; // 10 min
/** The crawl's maximum WALL-CLOCK duration = agent deadline + grace. Also the pg-boss job expiry. */
export const CRAWL_EXPIRE_SECONDS = MAX_CRAWL_SECONDS + CRAWL_DISPATCH_GRACE_SECONDS; // 40 min
/** The per-connection lock lease. Tied to CRAWL_EXPIRE so a live crawl's lease never expires under it. */
export const DEFAULT_LEASE_MS = CRAWL_EXPIRE_SECONDS * 1000; // 40 min
