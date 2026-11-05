import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

export const CATEGORY_KINDS = ["expense", "income"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const TRANSACTION_KINDS = ["expense", "income", "transfer_out", "transfer_in"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenHash: text("token_hash").notNull().unique(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const wallets = sqliteTable(
  "wallets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    initialBalanceMinor: integer("initial_balance_minor").notNull().default(0),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("wallets_user_idx").on(t.userId),
    check("wallets_currency_len", sql`length(${t.currency}) = 3`),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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

export const transfers = sqliteTable(
  "transfers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("transfers_user_idx").on(t.userId)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    amountMinor: integer("amount_minor").notNull(),
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
export type Wallet = typeof wallets.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
