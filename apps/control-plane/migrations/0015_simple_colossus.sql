ALTER TABLE "sessions" ADD COLUMN "promotion_ready_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sessions" AS session
SET "promotion_ready_at" = successful_done.created_at
FROM (
  SELECT session_id, max(created_at) AS created_at
  FROM "session_events"
  WHERE type = 'done' AND data->>'success' = 'true'
  GROUP BY session_id
) AS successful_done
WHERE session.id = successful_done.session_id
  AND session.promotion_ready_at IS NULL;
