-- User IDs: `username` (required, unique), `email` nullable, `name` split into `first_name` / `last_name`.
--
-- Hand-edited after `drizzle-kit generate` (which can only copy columns, not derive them). The table rebuild below
-- MUST run with foreign keys OFF: with them ON, `DROP TABLE users` performs an implicit `DELETE FROM users` and
-- every `ON DELETE CASCADE` child (sessions, wallets, categories, transfers, transactions) goes with it. The
-- `PRAGMA foreign_keys` lines drizzle-kit emits are no-ops here because the migrator wraps all pending migrations
-- in one transaction, so they were removed; src/db/index.ts switches foreign keys off before the migrator starts
-- and runs `PRAGMA foreign_key_check` after it.
--
-- Derivation for existing rows (docs/SPEC.md, "Migration of existing accounts"):
--   username   = local part of the email (before the first `@`), lowercased; every character outside
--                a–z 0–9 . _ - becomes `-`; leading `.` `_` `-` are dropped; cut to 32 characters;
--                fewer than 3 characters left → `user<id>`. When the same value was already taken by an account
--                with a lower id, `-<id>` is appended (the base is shortened so the result stays ≤ 32).
--   first_name = the trimmed name up to its first space (NULL when the name is blank)
--   last_name  = the rest after that space, trimmed (NULL when there is none)
--   email, password_hash, created_at and id are copied unchanged.
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`first_name` text,
	`last_name` text,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "email", "first_name", "last_name", "password_hash", "created_at")
WITH RECURSIVE
	src(id, local) AS (
		SELECT "id", lower(CASE WHEN instr("email", '@') > 0 THEN substr("email", 1, instr("email", '@') - 1) ELSE "email" END)
		FROM `users`
	),
	walk(id, rest, out) AS (
		SELECT id, local, '' FROM src
		UNION ALL
		SELECT id, substr(rest, 2),
			out || CASE WHEN instr('abcdefghijklmnopqrstuvwxyz0123456789._-', substr(rest, 1, 1)) > 0 THEN substr(rest, 1, 1) ELSE '-' END
		FROM walk WHERE rest <> ''
	),
	cleaned(id, base) AS (
		SELECT id, substr(ltrim(out, '._-'), 1, 32) FROM walk WHERE rest = ''
	),
	based(id, base) AS (
		SELECT id, CASE WHEN length(base) >= 3 THEN base ELSE 'user' || id END FROM cleaned
	),
	named(id, username) AS (
		SELECT b.id,
			CASE WHEN EXISTS (SELECT 1 FROM based o WHERE o.base = b.base AND o.id < b.id)
				THEN substr(b.base, 1, 32 - length('-' || b.id)) || '-' || b.id
				ELSE b.base END
		FROM based b
	),
	names(id, nm_full) AS (
		SELECT "id", trim("name") FROM `users`
	)
SELECT u."id", n.username, u."email",
	CASE WHEN nm.nm_full = '' THEN NULL WHEN instr(nm.nm_full, ' ') = 0 THEN nm.nm_full ELSE substr(nm.nm_full, 1, instr(nm.nm_full, ' ') - 1) END,
	CASE WHEN instr(nm.nm_full, ' ') = 0 THEN NULL ELSE nullif(trim(substr(nm.nm_full, instr(nm.nm_full, ' ') + 1)), '') END,
	u."password_hash", u."created_at"
FROM `users` u
JOIN named n ON n.id = u."id"
JOIN names nm ON nm.id = u."id";
--> statement-breakpoint
-- A suffixed user ID can still equal another account's plain one (e.g. `bob-5`); such a later account falls back
-- to `user<id>`. Anything still colliding makes the unique index below fail, which rolls the whole migration back.
UPDATE `__new_users` SET "username" = 'user' || "id"
WHERE EXISTS (SELECT 1 FROM `__new_users` o WHERE o."username" = `__new_users`."username" AND o."id" < `__new_users`."id");
--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
