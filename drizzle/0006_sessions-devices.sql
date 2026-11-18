ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_used_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Sessions that existed before this migration: their last use is unknown, so it starts at their sign-in.
UPDATE "sessions" SET "last_used_at" = "created_at";
