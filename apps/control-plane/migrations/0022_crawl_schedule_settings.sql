ALTER TABLE "connections" ADD COLUMN "crawl_schedule_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "crawl_timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "crawl_schedule_revision" integer DEFAULT 0 NOT NULL;