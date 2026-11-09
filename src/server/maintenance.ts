import "server-only";
import fs from "node:fs";
import { eq, or } from "drizzle-orm";
import { getDb, type DB } from "@/db";
import { users } from "@/db/schema";
import { currentMonth, monthRange, shiftMonth, todayISO } from "@/lib/dates";
import { DEMO_USER } from "@/lib/demo";
import { listCategories } from "@/server/categories";
import { createTransaction, type TransactionInput } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { registerUser } from "@/server/users";
import { createWalletGroup } from "@/server/wallet-groups";
import { createWallet } from "@/server/wallets";

/**
 * Development maintenance: wiping the database and seeding the demo account. Used by `scripts/reset.ts`
 * (`npm run db:reset`) and `scripts/seed.ts` (`npm run db:seed`). Not reachable from the app.
 */

export type TableCount = { table: string; rows: number };

/** Drizzle's bookkeeping table: never wiped, or the next start would re-run every migration. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Throws when `nodeEnv` is exactly `production` (the reset is a development tool). */
export function assertNotProduction(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset the database: NODE_ENV is \"production\". This command is for development only.");
  }
}

/** The app's own tables (everything except SQLite's internal tables and the migrations table), by name. */
export function appTables(db: DB): string[] {
  return (
    db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name",
      )
      .all(MIGRATIONS_TABLE) as { name: string }[]
  ).map((r) => r.name);
}

/** Row count of every app table. */
export function countRows(db: DB): TableCount[] {
  return appTables(db).map((table) => ({
    table,
    rows: (db.$client.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n,
  }));
}

/**
 * Delete every row of every app table in one transaction and reset the AUTOINCREMENT counters
 * (`sqlite_sequence`), so ids start at 1 again. The migrations table is kept.
 *
 * Foreign keys are switched off around the transaction (the pragma is a no-op inside one) so the order of the
 * deletes does not matter and nothing cascades — the counts returned are the rows each table actually held. They
 * are switched back on afterwards and `PRAGMA foreign_key_check` must come back empty, as after a migration.
 */
export function wipeAllData(db: DB): TableCount[] {
  const client = db.$client;
  if (client.inTransaction) throw new Error("wipeAllData must not be called inside a transaction.");

  const tables = appTables(db);
  const hasSequence = client.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
  const removed: TableCount[] = [];

  client.pragma("foreign_keys = OFF");
  try {
    client.transaction(() => {
      for (const table of tables) {
        removed.push({ table, rows: client.prepare(`DELETE FROM "${table}"`).run().changes });
      }
      if (hasSequence) client.prepare("DELETE FROM sqlite_sequence").run();
    })();
  } finally {
    client.pragma("foreign_keys = ON");
  }

  const violations = client.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) throw new Error(`Foreign key check failed after the reset: ${violations.length} row(s).`);
  return removed;
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Write a consistent copy of the database next to it with `VACUUM INTO` (as the pre-migration copy is written):
 * `<file>.before-reset-<YYYYMMDD-HHMMSS>.bak` in local time, with `-2`, `-3`… appended if that name is taken.
 */
export function backupBeforeReset(db: DB, file: string, now: Date = new Date()): string {
  if (file === ":memory:") throw new Error("An in-memory database cannot be copied to a file.");
  const base = `${file}.before-reset-${stamp(now)}`;
  let target = `${base}.bak`;
  for (let i = 2; fs.existsSync(target); i++) target = `${base}-${i}.bak`;
  db.$client.prepare("VACUUM INTO ?").run(target);
  return target;
}

/**
 * The demo user, found by user ID or by its email (a demo user seeded before user IDs existed was given a derived,
 * possibly suffixed, user ID by the 0001 migration).
 */
export function findDemoUser(db: DB = getDb()): { id: number; username: string } | undefined {
  return db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(or(eq(users.username, DEMO_USER.username), eq(users.email, DEMO_USER.email)))
    .get();
}

/**
 * Create the demo user (`DEMO_USER`) with two wallet groups (Personal, Business), six wallets and sample income, expenses and transfers for last month and
 * this month, through the services on the process-wide connection (`getDb()`). The caller checks that no demo user
 * exists yet (`findDemoUser`); registering a second one fails on the unique user ID.
 */
export async function seedDemoData(): Promise<{ userId: number; username: string; months: [string, string] }> {
  const user = await registerUser({ ...DEMO_USER });
  const cats = listCategories(user.id);
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`Demo seed: no default category "${name}".`);
    return c.id;
  };

  const eurBank = createWallet(user.id, { name: "ING Current", currency: "EUR", initialBalanceMinor: 250000 });
  const eurCash = createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 8000 });
  const usd = createWallet(user.id, { name: "Revolut USD", currency: "USD", initialBalanceMinor: 50000 });
  const ron = createWallet(user.id, { name: "BT Lei", currency: "RON", initialBalanceMinor: 120000 });
  createWallet(user.id, { name: "Japan trip", currency: "JPY", initialBalanceMinor: 30000 });
  const business = createWalletGroup(user.id, { name: "Business" });
  const studio = createWallet(user.id, { name: "Studio account", currency: "EUR", initialBalanceMinor: 600000, groupId: business.id });

  const today = todayISO();
  const thisMonth = currentMonth();
  const lastMonth = shiftMonth(thisMonth, -1);
  // Day N of a month, clamped so this month's dates are never in the future.
  const day = (month: string, n: number) => {
    const d = `${month}-${String(Math.min(n, Number(monthRange(month).to.slice(8)))).padStart(2, "0")}`;
    return d > today ? today : d;
  };

  const tx = (input: Omit<TransactionInput, "categoryId"> & { category: string }) => {
    const { category, ...rest } = input;
    createTransaction(user.id, { ...rest, categoryId: cat(category) });
  };

  for (const month of [lastMonth, thisMonth]) {
    tx({ walletId: eurBank.id, kind: "income", category: "Salary", amountMinor: 420000, date: day(month, 1), note: "Monthly salary" });
    tx({ walletId: eurBank.id, kind: "expense", category: "Housing", amountMinor: 115000, date: day(month, 2), note: "Rent" });
    tx({ walletId: eurBank.id, kind: "expense", category: "Bills", amountMinor: 8990, date: day(month, 5), note: "Electricity" });
    tx({ walletId: eurBank.id, kind: "expense", category: "Bills", amountMinor: 2999, date: day(month, 6), note: "Internet" });
    tx({ walletId: eurBank.id, kind: "expense", category: "Groceries", amountMinor: 6420, date: day(month, 3), note: "Weekly shop" });
    tx({ walletId: eurBank.id, kind: "expense", category: "Groceries", amountMinor: 5875, date: day(month, 10), note: "Weekly shop" });
    tx({ walletId: eurBank.id, kind: "expense", category: "Groceries", amountMinor: 7130, date: day(month, 17) });
    tx({ walletId: eurCash.id, kind: "expense", category: "Food", amountMinor: 1450, date: day(month, 4), note: "Lunch with Ana" });
    tx({ walletId: eurCash.id, kind: "expense", category: "Food", amountMinor: 380, date: day(month, 8), note: "Coffee" });
    tx({ walletId: eurCash.id, kind: "expense", category: "Transport", amountMinor: 4900, date: day(month, 1), note: "Monthly transit pass" });
    tx({ walletId: usd.id, kind: "expense", category: "Bills", amountMinor: 1599, date: day(month, 12), note: "Streaming subscription" });
    tx({ walletId: ron.id, kind: "expense", category: "Food", amountMinor: 8650, date: day(month, 14), note: "Dinner in Cluj" });
    tx({ walletId: ron.id, kind: "expense", category: "Transport", amountMinor: 3200, date: day(month, 15), note: "Taxi" });
  }
  for (const month of [lastMonth, thisMonth]) {
    tx({ walletId: studio.id, kind: "income", category: "Extra Income", amountMinor: 350000, date: day(month, 9), note: "Client invoice" });
    tx({ walletId: studio.id, kind: "expense", category: "Bills", amountMinor: 4900, date: day(month, 11), note: "Software licences" });
    tx({ walletId: studio.id, kind: "expense", category: "Housing", amountMinor: 60000, date: day(month, 3), note: "Coworking desk" });
  }
  tx({ walletId: usd.id, kind: "income", category: "Extra Income", amountMinor: 75000, date: day(lastMonth, 20), note: "Freelance invoice #12" });
  tx({ walletId: eurBank.id, kind: "income", category: "Refund", amountMinor: 2499, date: day(thisMonth, 3), note: "Returned headphones" });

  // Same-currency transfer (EUR → EUR), and two cross-currency ones (EUR → RON, USD → EUR).
  createTransfer(user.id, { fromWalletId: eurBank.id, toWalletId: eurCash.id, amountMinor: 20000, date: day(lastMonth, 7), note: "ATM withdrawal" });
  createTransfer(user.id, {
    fromWalletId: eurBank.id,
    toWalletId: ron.id,
    amountMinor: 30000,
    receivedAmountMinor: 149250,
    date: day(thisMonth, 2),
    note: "Top up lei account",
  });
  createTransfer(user.id, {
    fromWalletId: usd.id,
    toWalletId: eurBank.id,
    amountMinor: 40000,
    receivedAmountMinor: 36800,
    date: day(lastMonth, 25),
    note: "Move freelance money",
  });

  // Between the two groups: the studio pays the owner.
  createTransfer(user.id, { fromWalletId: studio.id, toWalletId: eurBank.id, amountMinor: 150000, date: day(thisMonth, 4), note: "Owner draw" });

  return { userId: user.id, username: user.username, months: [lastMonth, thisMonth] };
}
