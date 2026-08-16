ALTER TABLE "crawl_jobs" ADD COLUMN "claim_token" text NOT NULL;
--> statement-breakpoint
CREATE FUNCTION accrawl_claim_crawl_job(
  p_job_id uuid,
  p_claim_token text,
  p_worker_name text,
  p_lease_seconds integer
)
RETURNS TABLE(encrypted_payload text, job_status crawl_job_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE crawl_jobs AS job
  SET
    status = 'running',
    lease_owner = p_worker_name,
    lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600))),
    heartbeat_at = now(),
    started_at = coalesce(job.started_at, now())
  WHERE job.id = p_job_id
    AND job.claim_token = p_claim_token
    AND EXISTS (
      SELECT 1
      FROM sessions AS session
      WHERE session.id = job.session_id
        AND session.status IN (
          'starting',
          'logging_in',
          'navigating',
          'waiting_for_otp',
          'extracting'
        )
    )
    -- A Kubernetes Job can very rarely start the same pod template more than
    -- once. The claim is therefore irreversible: an expired worker is reaped
    -- and a later crawl gets a new session/job rather than ever allowing two
    -- bank logins to run for one session.
    AND job.status IN ('queued', 'starting')
  RETURNING job.encrypted_payload, job.status;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION accrawl_crawl_job_status(p_job_id uuid)
RETURNS crawl_job_status
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status crawl_job_status;
BEGIN
  SELECT job.status INTO current_status
  FROM crawl_jobs AS job
  WHERE job.id = p_job_id;
  RETURN current_status;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION accrawl_heartbeat_crawl_job(
  p_job_id uuid,
  p_claim_token text,
  p_worker_name text,
  p_lease_seconds integer
)
RETURNS crawl_job_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status crawl_job_status;
BEGIN
  UPDATE crawl_jobs AS job
  SET
    heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 600)))
  WHERE job.id = p_job_id
    AND job.claim_token = p_claim_token
    AND job.lease_owner = p_worker_name
    AND job.status = 'running'
  RETURNING job.status INTO current_status;

  IF current_status IS NULL THEN
    SELECT job.status INTO current_status
    FROM crawl_jobs AS job
    WHERE job.id = p_job_id AND job.claim_token = p_claim_token;
  END IF;
  RETURN current_status;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION accrawl_finish_crawl_job(
  p_job_id uuid,
  p_claim_token text,
  p_worker_name text,
  p_succeeded boolean,
  p_error text
)
RETURNS crawl_job_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  final_status crawl_job_status;
BEGIN
  UPDATE crawl_jobs AS job
  SET
    status = CASE
      WHEN job.status = 'cancel_requested' THEN 'cancelled'::crawl_job_status
      WHEN p_succeeded THEN 'succeeded'::crawl_job_status
      ELSE 'failed'::crawl_job_status
    END,
    error = CASE WHEN p_succeeded THEN NULL ELSE left(p_error, 2000) END,
    completed_at = now(),
    lease_expires_at = NULL,
    encrypted_payload = '',
    claim_token = ''
  WHERE job.id = p_job_id
    AND job.claim_token = p_claim_token
    AND job.lease_owner = p_worker_name
    AND job.status IN ('running', 'cancel_requested')
  RETURNING job.status INTO final_status;
  RETURN final_status;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_claim_crawl_job(uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_crawl_job_status(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_heartbeat_crawl_job(uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accrawl_finish_crawl_job(uuid, text, text, boolean, text) FROM PUBLIC;
