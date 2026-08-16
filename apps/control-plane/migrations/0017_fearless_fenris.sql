CREATE TABLE "device_pairing_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_subject" text NOT NULL,
	"name" text NOT NULL,
	"connection_grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"code_hash" text NOT NULL,
	"claim_hash" text,
	"verification_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"device_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairing_intents_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "device_pairing_intents_claim_hash_unique" UNIQUE("claim_hash"),
	CONSTRAINT "device_pairing_intents_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "owner_subject" text DEFAULT 'self-hosted:operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "owner_subject" text DEFAULT 'self-hosted:operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "owner_subject" text DEFAULT 'self-hosted:operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "connection_grants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tunnel_device_id" uuid;--> statement-breakpoint
ALTER TABLE "device_pairing_intents" ADD CONSTRAINT "device_pairing_intents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairing_intents_owner_idx" ON "device_pairing_intents" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "device_pairing_intents_expiry_idx" ON "device_pairing_intents" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tunnel_device_id_devices_id_fk" FOREIGN KEY ("tunnel_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_owner_idx" ON "api_keys" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "connections_owner_idx" ON "connections" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "devices_owner_idx" ON "devices" USING btree ("owner_subject");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_device_id_unique" UNIQUE("device_id");