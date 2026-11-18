import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const id = () => integer("id").primaryKey().generatedByDefaultAsIdentity();

export const CATEGORY_KINDS = ["expense", "income"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const TRANSACTION_KINDS = ["expense", "income", "transfer_out", "transfer_in"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Names of the unique indexes on `users` (src/server/users.ts maps a lost registration race by them). */
export const USERNAME_UNIQUE_INDEX = "users_username_lower_uq";
export const EMAIL_UNIQUE_INDEX = "users_email_lower_uq";

export const users = pgTable(
  "users",
  {
    id: id(),
    /** The "user ID" people sign in with: lowercased, 3–32 of a–z 0–9 . _ - (see src/lib/user-id.ts). */
    username: text("username").notNull(),
    /** Optional; lowercased. NULL (never '') when absent, so several accounts without email don't collide. */
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
  },
  // Unique on lower(...): sign-in and the duplicate checks compare `lower(username)` / `lower(email)`, so these
  // indexes serve those lookups and make case-only duplicates impossible in the database too.
  (t) => [
    uniqueIndex(USERNAME_UNIQUE_INDEX).on(sql`lower(${t.username})`),
    uniqueIndex(EMAIL_UNIQUE_INDEX).on(sql`lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const walletGroups = pgTable(
  "wallet_groups",
  {
    id: id(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Display order within the user's groups (ascending, then id); new groups go last. */
    position: integer("position").notNull().default(0),
    /** One of `GROUP_COLORS` (src/lib/group-colors.ts) or null for none; checked by the service. */
    color: text("color"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [index("wallet_groups_user_idx").on(t.userId)],
);

export const wallets = pgTable(
  "wallets",
  {
    id: id(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => walletGroups.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    initialBalanceMinor: bigint("initial_balance_minor", { mode: "number" }).notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("wallets_user_idx").on(t.userId),
    index("wallets_group_idx").on(t.groupId),
    check("wallets_currency_len", sql`length(${t.currency}) = 3`),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: id(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull(),
    /** Set while archived: hidden from the entry form's pickers, still in reports, history and exports. */
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("categories_user_kind_name_uq").on(t.userId, t.kind, t.name),
    check("categories_kind_chk", sql`${t.kind} in ('expense', 'income')`),
  ],
);

export const transfers = pgTable(
  "transfers",
  {
    id: id(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("transfers_user_idx").on(t.userId)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    walletId: integer("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: TRANSACTION_KINDS }).notNull(),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "restrict",
    }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    date: text("date").notNull(),
    note: text("note"),
    transferId: integer("transfer_id").references(() => transfers.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index("transactions_user_date_idx").on(t.userId, t.date),
    index("transactions_wallet_date_idx").on(t.walletId, t.date),
    index("transactions_transfer_idx").on(t.transferId),
    check("transactions_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "transactions_kind_shape",
      sql`(${t.kind} in ('expense', 'income') and ${t.categoryId} is not null and ${t.transferId} is null)
        or (${t.kind} in ('transfer_out', 'transfer_in') and ${t.categoryId} is null and ${t.transferId} is not null)`,
    ),
  ],
);

// Exchange rates (src/server/exchange-rates.ts, src/server/manual-rates.ts). Rates are exact decimals (`numeric`, read
// back as strings): what the provider published or the user typed, never a binary float. They are only ever used to
// show a converted figure; no converted amount is stored.

/**
 * The provider's daily reference rates (Frankfurter / ECB), shared by every user: `rate` units of `quote` for one
 * `base` on the publication day `rate_date` (`YYYY-MM-DD`). Weekends and holidays have no rows.
 */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    rateDate: text("rate_date").notNull(),
    rate: numeric("rate").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.base, t.quote, t.rateDate] }),
    check("exchange_rates_rate_positive", sql`${t.rate} > 0`),
  ],
);

/**
 * Every calendar day the provider has been asked about, and when: tells a day with no rates (weekend, holiday) from
 * one not fetched yet, so a stored range is never fetched again (see `isFinal` in src/server/exchange-rates.ts).
 */
export const exchangeRateDays = pgTable(
  "exchange_rate_days",
  {
    base: text("base").notNull(),
    date: text("date").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.base, t.date] })],
);

/**
 * A user's own rate for a currency the provider does not quote: 1 `currency` = `rate` `base` from `effective_date`
 * on (the latest one on or before a date applies). One per currency and date.
 */
export const manualRates = pgTable(
  "manual_exchange_rates",
  {
    id: id(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    base: text("base").notNull(),
    effectiveDate: text("effective_date").notNull(),
    rate: numeric("rate").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("manual_exchange_rates_user_currency_date_uq").on(t.userId, t.currency, t.effectiveDate),
    check("manual_exchange_rates_rate_positive", sql`${t.rate} > 0`),
    check("manual_exchange_rates_currencies", sql`length(${t.currency}) = 3 and length(${t.base}) = 3 and ${t.currency} <> ${t.base}`),
  ],
);

export type User = typeof users.$inferSelect;
export type WalletGroup = typeof walletGroups.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type ManualRateRow = typeof manualRates.$inferSelect;
