CREATE TYPE "public"."crawl_job_status" AS ENUM('queued', 'starting', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled');--> statement-breakpoint
CREATE TABLE "crawl_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"encrypted_payload" text NOT NULL,
	"status" "crawl_job_status" DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"worker_name" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "crawl_jobs_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_jobs_status_created_idx" ON "crawl_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "crawl_jobs_lease_idx" ON "crawl_jobs" USING btree ("lease_expires_at");