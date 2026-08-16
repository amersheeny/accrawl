ALTER TABLE "institutions" ADD COLUMN "owner_subject" text;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "catalog_key" text;--> statement-breakpoint
UPDATE "institutions" SET "catalog_key" = "id" WHERE "catalog_key" IS NULL;--> statement-breakpoint
CREATE INDEX "institutions_owner_idx" ON "institutions" USING btree ("owner_subject");
