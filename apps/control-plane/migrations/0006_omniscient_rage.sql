CREATE TABLE "email_otp_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"secure" boolean DEFAULT true NOT NULL,
	"username" text NOT NULL,
	"password_ct" text NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_otp_config_singleton" CHECK ("email_otp_config"."id" = 1)
);
