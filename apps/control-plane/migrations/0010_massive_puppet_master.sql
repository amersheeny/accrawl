CREATE TABLE "session_transaction_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"canonical_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"session_id" uuid,
	"scope_id" text NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_transaction_targets" ADD CONSTRAINT "session_transaction_targets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_transaction_targets" ADD CONSTRAINT "session_transaction_targets_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_occurrences" ADD CONSTRAINT "transaction_occurrences_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_occurrences" ADD CONSTRAINT "transaction_occurrences_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_occurrences" ADD CONSTRAINT "transaction_occurrences_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_transaction_targets_exact_uq" ON "session_transaction_targets" USING btree ("session_id","provider_account_id","canonical_id","transaction_id");--> statement-breakpoint
CREATE INDEX "session_transaction_targets_session_idx" ON "session_transaction_targets" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_occurrences_connection_scope_occurrence_uq" ON "transaction_occurrences" USING btree ("connection_id","scope_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "transaction_occurrences_session_idx" ON "transaction_occurrences" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "transaction_occurrences_transaction_idx" ON "transaction_occurrences" USING btree ("transaction_id");