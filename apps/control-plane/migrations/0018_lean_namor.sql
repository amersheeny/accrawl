CREATE TABLE "organization_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_subject" text NOT NULL,
	"owner_email" text NOT NULL,
	"organization_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"connection_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "authorization_codes" ADD COLUMN "owner_subject" text DEFAULT 'self-hosted:operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "recipient_tenant_id" text DEFAULT 'self-hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "owner_subject" text DEFAULT 'self-hosted:operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "owner_subject" text DEFAULT 'self-hosted:operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_shares" ADD CONSTRAINT "organization_shares_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_shares_owner_idx" ON "organization_shares" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "organization_shares_organization_idx" ON "organization_shares" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_shares_live_owner_organization_uq" ON "organization_shares" USING btree ("owner_subject","organization_id") WHERE "organization_shares"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "authorization_codes_owner_idx" ON "authorization_codes" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "oauth_grants_owner_idx" ON "oauth_grants" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "webhooks_owner_idx" ON "webhooks" USING btree ("owner_subject");
