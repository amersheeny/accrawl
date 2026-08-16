ALTER TABLE "sessions" ADD COLUMN "sync_counts" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Backfill existing rows' updated_at FROM created_at (not the migration-time now()): an unmodified
-- transaction must have updated_at == created_at so the change cursor classifies it as `added`, not
-- `modified`, on the first full-history sync. Truncate to milliseconds — a timestamp(3) column ROUNDS
-- (.123789 -> .124) whereas the JS-Date cursor TRUNCATES (.123), and the mismatch would flip an
-- unmodified row to `modified`; date_trunc matches the cursor's truncation exactly.
UPDATE "transactions" SET "updated_at" = date_trunc('milliseconds', "created_at");--> statement-breakpoint
CREATE INDEX "transactions_updated_at_idx" ON "transactions" USING btree ("updated_at","id");