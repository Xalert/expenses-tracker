/**
 * Demo data for local development: `npm run db:seed`.
 * Idempotent: if the demo user already exists nothing is written.
 * Uses the same DB as the app (data/app.db, or DATABASE_URL).
 */
import { eq } from "drizzle-orm";
import { getDb, resolveDatabasePath } from "@/db";
import { users } from "@/db/schema";
import { currentMonth, monthRange, shiftMonth, todayISO } from "@/lib/dates";
import { listCategories } from "@/server/categories";
import { createTransaction, type TransactionInput } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { registerUser } from "@/server/users";

const DEMO = { name: "Demo User", email: "demo@example.com", password: "demo-password" };

function printLogin() {
  console.log(`\n  Demo login → email: ${DEMO.email}   password: ${DEMO.password}\n`);
}

async function main() {
  const db = getDb();
  console.log(`Database: ${resolveDatabasePath()}`);

  if (db.select({ id: users.id }).from(users).where(eq(users.email, DEMO.email)).get()) {
    console.log("Demo user already exists — nothing to do.");
    printLogin();
    return;
  }

  const user = await registerUser(DEMO);
  const cat = (name: string) => listCategories(user.id).find((c) => c.name === name)!.id;

  const eurBank = createWallet(user.id, { name: "ING Current", currency: "EUR", initialBalanceMinor: 250000 });
  const eurCash = createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 8000 });
  const usd = createWallet(user.id, { name: "Revolut USD", currency: "USD", initialBalanceMinor: 50000 });
  const ron = createWallet(user.id, { name: "BT Lei", currency: "RON", initialBalanceMinor: 120000 });
  createWallet(user.id, { name: "Japan trip", currency: "JPY", initialBalanceMinor: 30000 });

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

  console.log(`Seeded demo user with 5 wallets and sample data for ${lastMonth} and ${thisMonth}.`);
  printLogin();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
