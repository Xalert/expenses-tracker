import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logDemoLogin, type DB } from "@/db";
import { DEMO_USER, demoLoginLine } from "@/lib/demo";
import {
  appTables,
  assertNotProduction,
  countRows,
  findDemoUser,
  seedDemoData,
  wipeAllData,
} from "@/server/maintenance";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const DEMO_COUNTS = { users: 1, sessions: 0, wallet_groups: 2, wallets: 6, categories: 8, transfers: 4, transactions: 42 };

async function counts(db: DB) {
  return Object.fromEntries((await countRows(db)).map((t) => [t.table, t.rows]));
}

describe("maintenance", () => {
  let db: DB;
  beforeEach(async () => {
    db = await useFreshDb();
  });

  it("lists the app tables but not the migrations table", async () => {
    expect(await appTables(db)).toEqual(["categories", "sessions", "transactions", "transfers", "users", "wallet_groups", "wallets"]);
  });

  it("wipes every row in one truncate and restarts the identity counters", async () => {
    const u = await makeUser(db, "a@x.test");
    const from = await createWallet(u.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const to = await createWallet(u.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    await createTransfer(u.id, { fromWalletId: from.id, toWalletId: to.id, amountMinor: 100, date: "2026-01-01" });

    const removed = Object.fromEntries((await wipeAllData(db)).map((t) => [t.table, t.rows]));
    expect(removed).toMatchObject({ users: 1, wallet_groups: 1, wallets: 2, categories: 8, transfers: 1, transactions: 2 });

    expect(Object.values(await counts(db)).every((n) => n === 0)).toBe(true);
    // Migrations are still recorded (drizzle keeps them in its own schema), so nothing re-runs on the next start.
    const applied = (await db.execute(sql`select count(*) as n from drizzle.__drizzle_migrations`)) as unknown as {
      rows: { n: string }[];
    };
    expect(Number(applied.rows[0].n)).toBeGreaterThan(0);
    // Identity counters restarted: the next user is id 1 again.
    expect((await makeUser(db, "b@x.test")).id).toBe(1);
  });

  it("reseeds the demo data with the same counts and ids from 1 after a wipe", async () => {
    const first = await seedDemoData();
    expect(first.userId).toBe(1);
    expect(await counts(db)).toEqual(DEMO_COUNTS);
    expect(await findDemoUser(db)).toEqual({ id: 1, username: DEMO_USER.username });

    await wipeAllData(db);
    const second = await seedDemoData();
    expect(second.userId).toBe(1);
    expect(await counts(db)).toEqual(DEMO_COUNTS);
    const walletIds = (await db.execute(sql`select id from wallets order by id`)) as unknown as { rows: { id: number }[] };
    expect(walletIds.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses under NODE_ENV=production only", () => {
    expect(() => assertNotProduction("production")).toThrow(/production/);
    expect(() => assertNotProduction("development")).not.toThrow();
    expect(() => assertNotProduction("test")).not.toThrow();
    expect(() => assertNotProduction(undefined)).not.toThrow();
  });
});

describe("demo login line", () => {
  it("reads the same everywhere", () => {
    expect(demoLoginLine()).toBe("[demo] Sign in with user ID demo / password demo-password (if unchanged)");
  });

  it("is logged once, outside production, only when the demo user exists", async () => {
    const db = await useFreshDb();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await logDemoLogin(db, "development")).toBe(false); // no demo user yet
      await seedDemoData();
      expect(await logDemoLogin(db, "production")).toBe(false);
      expect(await logDemoLogin(db, "development")).toBe(true);
      expect(await logDemoLogin(db, "development")).toBe(false); // once per process
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(demoLoginLine());
    } finally {
      log.mockRestore();
    }
  });
});
