import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase, logDemoLogin, type DB } from "@/db";
import { users } from "@/db/schema";
import { DEMO_USER, demoLoginLine } from "@/lib/demo";
import {
  appTables,
  assertNotProduction,
  backupBeforeReset,
  countRows,
  findDemoUser,
  seedDemoData,
  wipeAllData,
} from "@/server/maintenance";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const DEMO_COUNTS = { users: 1, sessions: 0, wallet_groups: 2, wallets: 6, categories: 8, transfers: 4, transactions: 42 };

function counts(db: DB) {
  return Object.fromEntries(countRows(db).map((t) => [t.table, t.rows]));
}

function sequence(db: DB) {
  return db.$client.prepare("SELECT name, seq FROM sqlite_sequence").all() as { name: string; seq: number }[];
}

describe("maintenance", () => {
  let db: DB;
  beforeEach(() => {
    db = useFreshDb();
  });

  it("lists the app tables but not the migrations table", () => {
    expect(appTables(db)).toEqual(["categories", "sessions", "transactions", "transfers", "users", "wallet_groups", "wallets"]);
  });

  it("wipes every row, keeps foreign keys on and resets the autoincrement counters", () => {
    const u = makeUser(db, "a@x.test");
    const from = createWallet(u.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const to = createWallet(u.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    createTransfer(u.id, { fromWalletId: from.id, toWalletId: to.id, amountMinor: 100, date: "2026-01-01" });
    expect(sequence(db).length).toBeGreaterThan(0);

    const removed = Object.fromEntries(wipeAllData(db).map((t) => [t.table, t.rows]));
    expect(removed).toMatchObject({ users: 1, wallet_groups: 1, wallets: 2, categories: 8, transfers: 1, transactions: 2 });

    expect(Object.values(counts(db)).every((n) => n === 0)).toBe(true);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    expect(sequence(db)).toEqual([]);
    // Migrations are still recorded, so nothing re-runs on the next start.
    expect((db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it("refuses to run inside a transaction", () => {
    expect(() => db.$client.transaction(() => wipeAllData(db))()).toThrow(/inside a transaction/);
  });

  it("reseeds the demo data with the same counts and ids from 1 after a wipe", async () => {
    const first = await seedDemoData();
    expect(first.userId).toBe(1);
    expect(counts(db)).toEqual(DEMO_COUNTS);
    expect(findDemoUser(db)).toEqual({ id: 1, username: DEMO_USER.username });

    wipeAllData(db);
    const second = await seedDemoData();
    expect(second.userId).toBe(1);
    expect(counts(db)).toEqual(DEMO_COUNTS);
    const walletIds = db.$client.prepare("SELECT id FROM wallets ORDER BY id").pluck().all();
    expect(walletIds).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses under NODE_ENV=production only", () => {
    expect(() => assertNotProduction("production")).toThrow(/production/);
    expect(() => assertNotProduction("development")).not.toThrow();
    expect(() => assertNotProduction("test")).not.toThrow();
    expect(() => assertNotProduction(undefined)).not.toThrow();
  });
});

describe("backupBeforeReset", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a self-contained copy named after the time, never overwriting one", () => {
    const file = path.join(dir, "app.db");
    const fileDb = createDatabase(file);
    fileDb.insert(users).values({ username: "a-x.test", passwordHash: "x" }).run();
    const now = new Date(2026, 10, 8, 9, 5, 7);

    const first = backupBeforeReset(fileDb, file, now);
    const second = backupBeforeReset(fileDb, file, now);
    fileDb.$client.close();

    expect(first).toBe(`${file}.before-reset-20261108-090507.bak`);
    expect(second).toBe(`${file}.before-reset-20261108-090507-2.bak`);
    const copy = new Database(first, { readonly: true });
    expect(copy.prepare("SELECT username FROM users").pluck().all()).toEqual(["a-x.test"]);
    copy.close();
  });
});

describe("demo login line", () => {
  it("reads the same everywhere", () => {
    expect(demoLoginLine()).toBe("[demo] Sign in with user ID demo / password demo-password (if unchanged)");
  });

  it("is logged once, outside production, only when the demo user exists", async () => {
    const db = useFreshDb();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(logDemoLogin(db, "development")).toBe(false); // no demo user yet
      await seedDemoData();
      expect(logDemoLogin(db, "production")).toBe(false);
      expect(logDemoLogin(db, "development")).toBe(true);
      expect(logDemoLogin(db, "development")).toBe(false); // once per process
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(demoLoginLine());
    } finally {
      log.mockRestore();
    }
  });
});
