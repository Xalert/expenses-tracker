import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
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

export const users = pgTable("users", {
  id: id(),
  /** The "user ID" people sign in with: lowercased, 3–32 of a–z 0–9 . _ - (see src/lib/user-id.ts). */
  username: text("username").notNull().unique(),
  /** Optional; lowercased. NULL (never '') when absent, so several accounts without email don't collide. */
  email: text("email").unique(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

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

export type User = typeof users.$inferSelect;
export type WalletGroup = typeof walletGroups.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
