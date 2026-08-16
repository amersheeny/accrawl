-- The engine may write only the crawl it was given. That was expressed with one mechanism — a per-crawl
-- claim checked against a running crawl_jobs lease — which only an ephemeral worker is ever handed, because
-- the launcher puts it in that worker's environment. A deployment that instead dispatches over HTTP to a
-- long-lived engine has no claim to issue and creates no job row, so the check could never pass and the
-- engine was locked out of its own database. It failed silently in the worst way: reads and updates matched
-- nothing, inserts were refused, and a crawl drove the browser to the end and recorded not one row of it.
--
-- Both dispatch styles are the same product, so say the rule in terms that cover both: a session reached
-- through a job belongs to that job's claim holder, and a session dispatched directly belongs to the engine
-- that was handed it. The predicate is the existence of the job row, which the engine cannot manufacture
-- (it holds no privilege on crawl_jobs, and the claim function only updates a row that is already there)
-- and cannot remove (nothing deletes one). Presenting a claim therefore never widens what an engine may
-- touch, and the ephemeral worker path keeps exactly the confinement it has today.
--
-- Existence, deliberately, rather than liveness: a lease can lapse mid-crawl, and a failing crawl writes
-- its terminal status, its staged rows and its final event in ONE transaction — so a predicate that can go
-- false partway would refuse the very record of the failure.
--
-- One constraint this rests on: a single database serves one dispatch style. Nothing in the product creates
-- a job row outside the job dispatcher, so the two rules cover disjoint sets of sessions today. A
-- deployment that ever mixed both styles in one database would let a worker reach the directly dispatched
-- sessions by declining to present its claim, and would need a stronger gate than the claim's own absence.
-- Presenting a claim must never widen what an engine may touch, so the two rules partition rather than
-- overlap: this one applies only to a connection that presents no claim at all, and only to a session that
-- was never dispatched through a job. A worker that dropped its claim to reach this rule would find it
-- empty, because in a deployment that dispatches through jobs every session has one.
CREATE FUNCTION accrawl_session_dispatched_directly(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT nullif(current_setting('accrawl.job_id', true), '') IS NULL
     AND nullif(current_setting('accrawl.claim_token', true), '') IS NULL
     AND nullif(current_setting('accrawl.worker_name', true), '') IS NULL
     AND NOT EXISTS (SELECT 1 FROM crawl_jobs AS job WHERE job.session_id = p_session_id)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_session_dispatched_directly(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Permissive policies are OR-combined with the claim-scoped ones already in place, so each session is
-- covered by exactly one of the two rules and neither loosens the other.
CREATE POLICY "sessions_engine_direct_select" ON "sessions"
  FOR SELECT USING (accrawl_session_dispatched_directly(id));
--> statement-breakpoint
-- USING chooses the rows that may be written; WITH CHECK repeats the same test rather than re-examining the
-- result, so a crawl can still record its own terminal status.
CREATE POLICY "sessions_engine_direct_update" ON "sessions"
  FOR UPDATE USING (accrawl_session_dispatched_directly(id))
  WITH CHECK (accrawl_session_dispatched_directly(id));
--> statement-breakpoint
CREATE POLICY "session_events_engine_direct_select" ON "session_events"
  FOR SELECT USING (accrawl_session_dispatched_directly(session_id));
--> statement-breakpoint
CREATE POLICY "session_events_engine_direct_insert" ON "session_events"
  FOR INSERT WITH CHECK (accrawl_session_dispatched_directly(session_id));
--> statement-breakpoint
CREATE POLICY "session_steps_engine_direct_select" ON "session_steps"
  FOR SELECT USING (accrawl_session_dispatched_directly(session_id));
--> statement-breakpoint
CREATE POLICY "session_steps_engine_direct_insert" ON "session_steps"
  FOR INSERT WITH CHECK (accrawl_session_dispatched_directly(session_id));
--> statement-breakpoint
CREATE POLICY "session_steps_engine_direct_update" ON "session_steps"
  FOR UPDATE USING (accrawl_session_dispatched_directly(session_id))
  WITH CHECK (accrawl_session_dispatched_directly(session_id));
--> statement-breakpoint
CREATE POLICY "staged_records_engine_direct_insert" ON "staged_records"
  FOR INSERT WITH CHECK (accrawl_session_dispatched_directly(session_id));
