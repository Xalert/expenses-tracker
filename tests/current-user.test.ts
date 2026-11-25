import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { recurringTransactions, sessions, transactions, users } from "@/db/schema";
import { addDays } from "@/lib/dates";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

// getCurrentUser reads the session cookie through next/headers; the test decides which token the request carries.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (jar.token ? { name: "et_session", value: jar.token } : undefined) }),
  headers: async () => ({ get: () => null }),
}));

const { getCurrentUser } = await import("@/lib/auth");
const { todayInZone } = await import("@/lib/dates");

let db: DB;

beforeEach(async () => {
  db = await useFreshDb();
});

async function signIn(timeZone: string | null) {
  const alice = await makeUser(db, "alice@example.com");
  await db.update(users).set({ timeZone }).where(eq(users.id, alice.id));
  jar.token = `token-${Math.random()}`;
  await db.insert(sessions).values({
    tokenHash: createHash("sha256").update(jar.token).digest("hex"),
    userId: alice.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return alice;
}

describe("getCurrentUser: the account's time zone", () => {
  it("carries the stored zone, which todayInZone turns into the user's date", async () => {
    const alice = await signIn("Pacific/Auckland");
    const user = await getCurrentUser();
    expect(user).toMatchObject({ id: alice.id, timeZone: "Pacific/Auckland" });
    expect(todayInZone(user!.timeZone, new Date("2026-11-24T11:00:00Z"))).toBe("2026-11-25");
  });

  it("is null without a zone, and for a stored zone this runtime does not know", async () => {
    await signIn(null);
    expect((await getCurrentUser())?.timeZone).toBeNull();
    await useFreshDb();
    await signIn("Mars/Olympus_Mons");
    expect((await getCurrentUser())?.timeZone).toBeNull();
  });
});

describe("getCurrentUser: repeating entries", () => {
  it("creates the entries that are due up to the user's today before anything reads", async () => {
    const alice = await signIn(null);
    const wallet = await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    const today = todayInZone(null);
    const start = addDays(today, -2);
    await db.insert(recurringTransactions).values({
      userId: alice.id,
      walletId: wallet.id,
      kind: "expense",
      categoryId: alice.cat("Food"),
      amountMinor: 500,
      frequency: "daily",
      interval: 1,
      startDate: start,
      nextDate: start,
    });
    expect(await getCurrentUser()).toMatchObject({ id: alice.id });
    const rows = await db.select({ date: transactions.date }).from(transactions).orderBy(transactions.date);
    expect(rows.map((r) => r.date)).toEqual([start, addDays(today, -1), today]);
    // A second request has nothing left to do.
    await getCurrentUser();
    expect(await db.select().from(transactions)).toHaveLength(3);
  });
});
