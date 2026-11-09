-- Wallet groups. `wallets` gains a NOT NULL `group_id`, which SQLite can only add by rebuilding the table, so this
-- file was edited by hand after `drizzle-kit generate` (it emitted an ALTER ... ADD NOT NULL that fails on any
-- populated database). The runner in src/db/index.ts switches foreign keys off around the migrator, so DROP TABLE
-- `wallets` does not touch `transactions` (restrict) and every id is kept. drizzle-kit's own `PRAGMA foreign_keys`
-- lines are left out: they are no-ops inside the migrator's transaction.
CREATE TABLE `wallet_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wallet_groups_user_idx` ON `wallet_groups` (`user_id`);--> statement-breakpoint
-- One `Personal` group per existing user (created_at is epoch seconds, like every other created_at).
INSERT INTO `wallet_groups` (`user_id`, `name`, `created_at`)
SELECT `id`, 'Personal', unixepoch() FROM `users` ORDER BY `id`;
--> statement-breakpoint
CREATE TABLE `__new_wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`initial_balance_minor` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `wallet_groups`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "wallets_currency_len" CHECK(length("currency") = 3)
);
--> statement-breakpoint
INSERT INTO `__new_wallets` (`id`, `user_id`, `group_id`, `name`, `currency`, `initial_balance_minor`, `archived_at`, `created_at`)
-- A wallet whose owner is missing has no group: the NOT NULL fails and the whole migration is rolled back, rather
-- than the wallet being dropped silently.
SELECT w.`id`, w.`user_id`, (SELECT g.`id` FROM `wallet_groups` g WHERE g.`user_id` = w.`user_id`), w.`name`, w.`currency`, w.`initial_balance_minor`, w.`archived_at`, w.`created_at`
FROM `wallets` w;
--> statement-breakpoint
DROP TABLE `wallets`;--> statement-breakpoint
ALTER TABLE `__new_wallets` RENAME TO `wallets`;--> statement-breakpoint
CREATE INDEX `wallets_user_idx` ON `wallets` (`user_id`);--> statement-breakpoint
CREATE INDEX `wallets_group_idx` ON `wallets` (`group_id`);
