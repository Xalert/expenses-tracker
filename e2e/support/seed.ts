/**
 * Seeding helpers for the e2e tests: they call the app's own services (src/server/*) in the Playwright process, on
 * the e2e database (playwright.config.ts sets DATABASE_URL to E2E_DATABASE_URL and refuses anything else). Every
 * test makes its own user, so tests never share data and can run in parallel.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, schema } from "@/db";
import { todayInZone } from "@/lib/dates";
import { listCategories, type CategoryView } from "@/server/categories";
import { setManualRate } from "@/server/manual-rates";
import { createTransaction } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { registerUser } from "@/server/users";
import { createWalletGroup } from "@/server/wallet-groups";
import { createWallet, type WalletView } from "@/server/wallets";

export const PASSWORD = "e2e-password-1";
export const SESSION_COOKIE = "et_session";

/** Every seeded user's account time zone (and the browser's: `timezoneId` in playwright.config.ts). */
export const E2E_TIME_ZONE = "Europe/Berlin";

/** Today as the app sees it for a seeded user: in the account's zone, not this process's (CI runs in UTC). */
export function todayISO(timeZone: string = E2E_TIME_ZONE): string {
  return todayInZone(timeZone);
}

/** The current month for a seeded user (see `todayISO`). */
export function currentMonth(timeZone: string = E2E_TIME_ZONE): string {
  return todayISO(timeZone).slice(0, 7);
}

let counter = 0;
/** A user ID nobody else in this run has (lowercase letters, digits and dashes). */
export function uniqueUsername(prefix = "u"): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}-${randomBytes(3).toString("hex")}`.toLowerCase();
}

export type SeededUser = {
  id: number;
  username: string;
  password: string;
  /** A ready session token for the `et_session` cookie (as `createSession` would set). */
  token: string;
};

/** Register a user (default categories and group included) and open a session for it. */
export async function seedUser(opts: { username?: string; firstName?: string; timeZone?: string } = {}): Promise<SeededUser> {
  const username = opts.username ?? uniqueUsername();
  const user = await registerUser({
    username,
    password: PASSWORD,
    firstName: opts.firstName,
    timeZone: opts.timeZone ?? E2E_TIME_ZONE,
  });
  const token = await openSession(user.id, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36");
  return { id: user.id, username, password: PASSWORD, token };
}

/** Insert a session row for `userId`; returns the cookie token. */
export async function openSession(userId: number, userAgent: string | null = null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await (await getDb()).insert(schema.sessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    userAgent,
  });
  return token;
}

export async function seedWallet(
  userId: number,
  input: { name: string; currency: string; initialBalanceMinor?: number; groupId?: number },
): Promise<WalletView> {
  return createWallet(userId, { initialBalanceMinor: 0, ...input });
}

export async function seedGroup(userId: number, name: string, color: string | null = null) {
  return createWalletGroup(userId, { name, color });
}

export async function categoryByName(userId: number, name: string): Promise<CategoryView> {
  const found = (await listCategories(userId, undefined, { includeArchived: true })).find((c) => c.name === name);
  if (!found) throw new Error(`No category ${name}`);
  return found;
}

/** An expense / income on `date` (default today), `amountMinor` in the wallet's minor units. */
export async function seedEntry(
  userId: number,
  input: { walletId: number; kind: "expense" | "income"; category: string; amountMinor: number; date?: string; note?: string },
) {
  const category = await categoryByName(userId, input.category);
  return createTransaction(userId, {
    walletId: input.walletId,
    kind: input.kind,
    categoryId: category.id,
    amountMinor: input.amountMinor,
    date: input.date ?? todayISO(),
    note: input.note ?? null,
  });
}

export async function seedTransfer(
  userId: number,
  input: { fromWalletId: number; toWalletId: number; amountMinor: number; receivedAmountMinor?: number; date?: string; note?: string },
) {
  return createTransfer(userId, { ...input, date: input.date ?? todayISO(), note: input.note ?? null });
}

export async function seedManualRate(
  userId: number,
  input: { currency: string; base: string; rate: string; effectiveDate?: string },
) {
  return setManualRate(userId, { ...input, effectiveDate: input.effectiveDate ?? `${currentMonth()}-01` });
}
