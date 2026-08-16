CREATE TABLE "operator_credential" (
	"id" integer PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"token_signing_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_credential_singleton" CHECK ("operator_credential"."id" = 1)
);
