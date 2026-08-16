CREATE TYPE "public"."config_source" AS ENUM('builtin', 'local', 'imported');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connecting', 'connected', 'syncing', 'needs_reauth', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."crawl_scope" AS ENUM('balances_only', 'include_transactions', 'full');--> statement-breakpoint
CREATE TYPE "public"."institution_type" AS ENUM('bank', 'broker', 'retirement');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('pending', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting', 'cancelling', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."staged_kind" AS ENUM('account', 'transaction', 'position');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"missing_since_crawl_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hashed_key" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connection_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hashed_key_unique" UNIQUE("hashed_key")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" text NOT NULL,
	"username_ct" text NOT NULL,
	"password_ct" text NOT NULL,
	"dob_ct" text,
	"phone_ct" text,
	"login_domain_verified" boolean DEFAULT false NOT NULL,
	"login_url_override" text,
	"custom_instructions" text,
	"crawl_schedule" text DEFAULT '0 6 * * *' NOT NULL,
	"crawl_memory" text,
	"status" "connection_status" DEFAULT 'connecting' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"crawl_stats" jsonb DEFAULT '{"totalCount":0,"completedCount":0,"failedCount":0,"consecutiveFailures":0,"avgCostUsd":0,"recentCosts":[]}'::jsonb NOT NULL,
	"nickname" text,
	"safe_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections_due" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"next_crawl_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hashed_token" text NOT NULL,
	"push_transport" text,
	"push_token" text,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_hashed_token_unique" UNIQUE("hashed_token")
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"login_url" text NOT NULL,
	"canonical_domain" text NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"type" "institution_type" NOT NULL,
	"country" text,
	"logo" text,
	"playbook" text,
	"extraction_hints" jsonb,
	"login_hints" jsonb,
	"requires_2fa" boolean DEFAULT false NOT NULL,
	"otp_sender_pattern" text,
	"use_device_proxy" boolean DEFAULT false NOT NULL,
	"model" text,
	"max_steps" integer DEFAULT 120 NOT NULL,
	"timeout_seconds" integer DEFAULT 900 NOT NULL,
	"transaction_lookback_days" integer DEFAULT 14 NOT NULL,
	"source" "config_source" DEFAULT 'local' NOT NULL,
	"scan_status" "scan_status" DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"screenshot_ref" text,
	"log" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" "session_status" DEFAULT 'starting' NOT NULL,
	"scope" "crawl_scope" DEFAULT 'full' NOT NULL,
	"current_step" text,
	"step_count" integer DEFAULT 0 NOT NULL,
	"otp_requested" boolean DEFAULT false NOT NULL,
	"otp_requested_at" timestamp with time zone,
	"otp" text,
	"otp_received_at" timestamp with time zone,
	"tunnel_requested" boolean DEFAULT false NOT NULL,
	"tunnel_claimed_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"cost" jsonb,
	"error" text,
	"failure_reason" text,
	"crawl_memory" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staged_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "staged_kind" NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections_due" ADD CONSTRAINT "connections_due_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_steps" ADD CONSTRAINT "session_steps_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_records" ADD CONSTRAINT "staged_records_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_connection_idx" ON "accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "connections_institution_idx" ON "connections" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "connections_due_next_idx" ON "connections_due" USING btree ("next_crawl_at");--> statement-breakpoint
CREATE INDEX "positions_connection_idx" ON "positions" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_session_seq_idx" ON "session_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_steps_session_step_idx" ON "session_steps" USING btree ("session_id","step_number");--> statement-breakpoint
CREATE INDEX "sessions_connection_idx" ON "sessions" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_connection_uq" ON "sessions" USING btree ("connection_id") WHERE status in ('starting','logging_in','navigating','waiting_for_otp','extracting');--> statement-breakpoint
CREATE INDEX "sessions_active_heartbeat_idx" ON "sessions" USING btree ("heartbeat_at") WHERE status in ('starting','logging_in','navigating','waiting_for_otp','extracting');--> statement-breakpoint
CREATE INDEX "sessions_active_lease_idx" ON "sessions" USING btree ("lease_expires_at") WHERE status in ('starting','logging_in','navigating','waiting_for_otp','extracting');--> statement-breakpoint
CREATE INDEX "staged_records_session_idx" ON "staged_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "transactions_connection_idx" ON "transactions" USING btree ("connection_id");
