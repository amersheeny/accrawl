ALTER TABLE "sessions" ADD COLUMN "otp_relay_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "otp_relay_online_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "otp_relay_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "otp_relay_ready_at" timestamp with time zone;
