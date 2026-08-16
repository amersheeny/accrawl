ALTER TABLE "crawl_jobs" ADD COLUMN "claim_token_hash" text;
--> statement-breakpoint
UPDATE "crawl_jobs"
SET "claim_token_hash" = encode(sha256(convert_to("claim_token", 'UTF8')), 'hex');
--> statement-breakpoint
ALTER TABLE "crawl_jobs" ALTER COLUMN "claim_token_hash" SET NOT NULL;
--> statement-breakpoint
CREATE FUNCTION accrawl_engine_owns_session(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  scoped_job_id uuid;
  scoped_claim_token text;
  scoped_worker_name text;
BEGIN
  scoped_job_id := nullif(current_setting('accrawl.job_id', true), '')::uuid;
  scoped_claim_token := nullif(current_setting('accrawl.claim_token', true), '');
  scoped_worker_name := nullif(current_setting('accrawl.worker_name', true), '');
  IF scoped_job_id IS NULL OR scoped_claim_token IS NULL OR scoped_worker_name IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM crawl_jobs AS job
    WHERE job.id = scoped_job_id
      AND job.session_id = p_session_id
      AND job.claim_token = scoped_claim_token
      AND job.lease_owner = scoped_worker_name
      AND job.status = 'running'
      AND job.lease_expires_at > now()
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION accrawl_observe_crawl_job(
  p_job_id uuid,
  p_claim_token text
)
RETURNS TABLE(job_status crawl_job_status, observed_session_status session_status)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT job.status, session.status
  FROM crawl_jobs AS job
  JOIN sessions AS session ON session.id = job.session_id
  WHERE job.id = p_job_id
    AND job.claim_token_hash = encode(sha256(convert_to(p_claim_token, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_engine_owns_session(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_observe_crawl_job(uuid, text) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sessions_engine_select_scope" ON "sessions"
  FOR SELECT USING (accrawl_engine_owns_session(id));
--> statement-breakpoint
CREATE POLICY "sessions_engine_update_scope" ON "sessions"
  FOR UPDATE USING (accrawl_engine_owns_session(id))
  WITH CHECK (accrawl_engine_owns_session(id));
--> statement-breakpoint
ALTER TABLE "session_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "session_events_engine_select_scope" ON "session_events"
  FOR SELECT USING (accrawl_engine_owns_session(session_id));
--> statement-breakpoint
CREATE POLICY "session_events_engine_insert_scope" ON "session_events"
  FOR INSERT WITH CHECK (accrawl_engine_owns_session(session_id));
--> statement-breakpoint
ALTER TABLE "session_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "session_steps_engine_select_scope" ON "session_steps"
  FOR SELECT USING (accrawl_engine_owns_session(session_id));
--> statement-breakpoint
CREATE POLICY "session_steps_engine_insert_scope" ON "session_steps"
  FOR INSERT WITH CHECK (accrawl_engine_owns_session(session_id));
--> statement-breakpoint
CREATE POLICY "session_steps_engine_update_scope" ON "session_steps"
  FOR UPDATE USING (accrawl_engine_owns_session(session_id))
  WITH CHECK (accrawl_engine_owns_session(session_id));
--> statement-breakpoint
ALTER TABLE "staged_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "staged_records_engine_insert_scope" ON "staged_records"
  FOR INSERT WITH CHECK (accrawl_engine_owns_session(session_id));
