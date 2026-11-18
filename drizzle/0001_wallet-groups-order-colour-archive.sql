ALTER TABLE "wallet_groups" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_groups" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "wallet_groups" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- Hand-written: keep today's order (by name ignoring case, then id) as positions 1..n per user.
UPDATE "wallet_groups" AS g
SET "position" = o."rn"
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "user_id" ORDER BY lower("name"), "id") AS "rn"
  FROM "wallet_groups"
) AS o
WHERE g."id" = o."id";
