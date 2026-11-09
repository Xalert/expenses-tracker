import "server-only";
import { eq, or, sql, type SQL } from "drizzle-orm";
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

/** Throws when `nodeEnv` is exactly `production` (the reset is a development tool). */
export function assertNotProduction(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    throw new Error("Refusing to reset the database: NODE_ENV is \"production\". This command is for development only.");
  }
}

/** Rows of a raw query; `execute` is typed `unknown` on the driver-agnostic `DB`, both drivers return `{ rows }`. */
async function queryRows<T>(db: DB, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

/**
 * The app's own tables (schema `public`; drizzle keeps its bookkeeping table `__drizzle_migrations` in the
 * separate schema `drizzle`, so it is never listed and never wiped), by name.
 */
export async function appTables(db: DB): Promise<string[]> {
  const rows = await queryRows<{ table_name: string }>(
    db,
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  return rows.map((r) => r.table_name);
}

/** Row count of every app table. */
export async function countRows(db: DB): Promise<TableCount[]> {
  const counts: TableCount[] = [];
  for (const table of await appTables(db)) {
    const rows = await queryRows<{ n: string | number }>(db, sql`select count(*) as n from ${sql.identifier(table)}`);
    counts.push({ table, rows: Number(rows[0]?.n ?? 0) });
  }
  return counts;
}

/**
 * Empty every app table with one `TRUNCATE ... RESTART IDENTITY CASCADE` (so ids start at 1 again and the order of
 * the tables does not matter). Returns the rows each table held beforehand.
 */
export async function wipeAllData(db: DB): Promise<TableCount[]> {
  const before = await countRows(db);
  if (before.length > 0) {
    const names = sql.join(
      before.map((t) => sql.identifier(t.table)),
      sql`, `,
    );
    await db.execute(sql`truncate table ${names} restart identity cascade`);
  }
  return before;
}

/**
 * The demo user, found by user ID or by its email.
 */
export async function findDemoUser(db?: DB): Promise<{ id: number; username: string } | undefined> {
  const conn = db ?? (await getDb());
  const [row] = await conn
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(or(eq(users.username, DEMO_USER.username), eq(users.email, DEMO_USER.email)))
    .limit(1);
  return row;
}

/**
 * Create the demo user (`DEMO_USER`) with two wallet groups (Personal, Business), six wallets and sample income, expenses and transfers for last month and
 * this month, through the services on the process-wide connection (`getDb()`). The caller checks that no demo user
 * exists yet (`findDemoUser`); registering a second one fails on the unique user ID.
 */
export async function seedDemoData(): Promise<{ userId: number; username: string; months: [string, string] }> {
  const user = await registerUser({ ...DEMO_USER });
  const cats = await listCategories(user.id);
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`Demo seed: no default category "${name}".`);
    return c.id;
  };

  const eurBank = await createWallet(user.id, { name: "ING Current", currency: "EUR", initialBalanceMinor: 250000 });
  const eurCash = await createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 8000 });
  const usd = await createWallet(user.id, { name: "Revolut USD", currency: "USD", initialBalanceMinor: 50000 });
  const ron = await createWallet(user.id, { name: "BT Lei", currency: "RON", initialBalanceMinor: 120000 });
  await createWallet(user.id, { name: "Japan trip", currency: "JPY", initialBalanceMinor: 30000 });
  const business = await createWalletGroup(user.id, { name: "Business" });
  const studio = await createWallet(user.id, { name: "Studio account", currency: "EUR", initialBalanceMinor: 600000, groupId: business.id });

  const today = todayISO();
  const thisMonth = currentMonth();
  const lastMonth = shiftMonth(thisMonth, -1);
  // Day N of a month, clamped so this month's dates are never in the future.
  const day = (month: string, n: number) => {
    const d = `${month}-${String(Math.min(n, Number(monthRange(month).to.slice(8)))).padStart(2, "0")}`;
    return d > today ? today : d;
  };

  const tx = async (input: Omit<TransactionInput, "categoryId"> & { category: string }) => {
    const { category, ...rest } = input;
    await createTransaction(user.id, { ...rest, categoryId: cat(category) });
  };

  for (const month of [lastMonth, thisMonth]) {
    await tx({ walletId: eurBank.id, kind: "income", category: "Salary", amountMinor: 420000, date: day(month, 1), note: "Monthly salary" });
    await tx({ walletId: eurBank.id, kind: "expense", category: "Housing", amountMinor: 115000, date: day(month, 2), note: "Rent" });
    await tx({ walletId: eurBank.id, kind: "expense", category: "Bills", amountMinor: 8990, date: day(month, 5), note: "Electricity" });
    await tx({ walletId: eurBank.id, kind: "expense", category: "Bills", amountMinor: 2999, date: day(month, 6), note: "Internet" });
    await tx({ walletId: eurBank.id, kind: "expense", category: "Groceries", amountMinor: 6420, date: day(month, 3), note: "Weekly shop" });
    await tx({ walletId: eurBank.id, kind: "expense", category: "Groceries", amountMinor: 5875, date: day(month, 10), note: "Weekly shop" });
    await tx({ walletId: eurBank.id, kind: "expense", category: "Groceries", amountMinor: 7130, date: day(month, 17) });
    await tx({ walletId: eurCash.id, kind: "expense", category: "Food", amountMinor: 1450, date: day(month, 4), note: "Lunch with Ana" });
    await tx({ walletId: eurCash.id, kind: "expense", category: "Food", amountMinor: 380, date: day(month, 8), note: "Coffee" });
    await tx({ walletId: eurCash.id, kind: "expense", category: "Transport", amountMinor: 4900, date: day(month, 1), note: "Monthly transit pass" });
    await tx({ walletId: usd.id, kind: "expense", category: "Bills", amountMinor: 1599, date: day(month, 12), note: "Streaming subscription" });
    await tx({ walletId: ron.id, kind: "expense", category: "Food", amountMinor: 8650, date: day(month, 14), note: "Dinner in Cluj" });
    await tx({ walletId: ron.id, kind: "expense", category: "Transport", amountMinor: 3200, date: day(month, 15), note: "Taxi" });
  }
  for (const month of [lastMonth, thisMonth]) {
    await tx({ walletId: studio.id, kind: "income", category: "Extra Income", amountMinor: 350000, date: day(month, 9), note: "Client invoice" });
    await tx({ walletId: studio.id, kind: "expense", category: "Bills", amountMinor: 4900, date: day(month, 11), note: "Software licences" });
    await tx({ walletId: studio.id, kind: "expense", category: "Housing", amountMinor: 60000, date: day(month, 3), note: "Coworking desk" });
  }
  await tx({ walletId: usd.id, kind: "income", category: "Extra Income", amountMinor: 75000, date: day(lastMonth, 20), note: "Freelance invoice #12" });
  await tx({ walletId: eurBank.id, kind: "income", category: "Refund", amountMinor: 2499, date: day(thisMonth, 3), note: "Returned headphones" });

  // Same-currency transfer (EUR → EUR), and two cross-currency ones (EUR → RON, USD → EUR).
  await createTransfer(user.id, { fromWalletId: eurBank.id, toWalletId: eurCash.id, amountMinor: 20000, date: day(lastMonth, 7), note: "ATM withdrawal" });
  await createTransfer(user.id, {
    fromWalletId: eurBank.id,
    toWalletId: ron.id,
    amountMinor: 30000,
    receivedAmountMinor: 149250,
    date: day(thisMonth, 2),
    note: "Top up lei account",
  });
  await createTransfer(user.id, {
    fromWalletId: usd.id,
    toWalletId: eurBank.id,
    amountMinor: 40000,
    receivedAmountMinor: 36800,
    date: day(lastMonth, 25),
    note: "Move freelance money",
  });

  // Between the two groups: the studio pays the owner.
  await createTransfer(user.id, { fromWalletId: studio.id, toWalletId: eurBank.id, amountMinor: 150000, date: day(thisMonth, 4), note: "Owner draw" });

  return { userId: user.id, username: user.username, months: [lastMonth, thisMonth] };
}
