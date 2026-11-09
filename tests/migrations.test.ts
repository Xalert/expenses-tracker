/**
 * The Postgres migrations (drizzle/) on an in-process Postgres (PGlite): they apply to an empty database, applying
 * them again is a no-op, and the constraints they create (check constraints, foreign keys with restrict / cascade)
 * behave as the schema file promises. Also the URL helpers in src/db/index.ts.
 */
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_DATABASE_URL,
  describeDatabase,
  resolveDatabaseUrl,
  resolveMigrationsDir,
  setDb,
  type DB,
} from "@/db";
import { createTestDatabase } from "@/db/test";
import { categories, sessions, transactions, transfers, users, walletGroups, wallets } from "@/db/schema";
import { pgError } from "@/server/_validate";
import { useFreshDb } from "./helpers";

async function rows<T>(db: DB, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

/** The SQLSTATE of the Postgres error a statement raises, or null when it succeeds. */
async function sqlState(run: () => PromiseLike<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    throw err;
  }
}

afterEach(() => setDb(undefined));

describe("migrations on an empty database", () => {
  it("create the app tables and record themselves in drizzle's own schema", async () => {
    const db = await createTestDatabase();
    const tables = await rows<{ table_name: string }>(
      db,
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      "categories",
      "sessions",
      "transactions",
      "transfers",
      "users",
      "wallet_groups",
      "wallets",
    ]);
    const applied = await rows<{ n: string }>(db, sql`select count(*) as n from drizzle.__drizzle_migrations`);
    expect(Number(applied[0].n)).toBeGreaterThan(0);
  });

  it("are a no-op the second time", async () => {
    const db = await createTestDatabase();
    const count = async () =>
      Number((await rows<{ n: string }>(db, sql`select count(*) as n from drizzle.__drizzle_migrations`))[0].n);
    const before = await count();
    await migrate(db as never, { migrationsFolder: resolveMigrationsDir() });
    expect(await count()).toBe(before);
  });
});

describe("constraints", () => {
  let db: DB;
  let userId: number;
  let groupId: number;
  let walletId: number;
  let categoryId: number;

  beforeEach(async () => {
    db = await useFreshDb();
    [{ id: userId }] = await db.insert(users).values({ username: "u", passwordHash: "x" }).returning({ id: users.id });
    [{ id: groupId }] = await db.insert(walletGroups).values({ userId, name: "Personal" }).returning({ id: walletGroups.id });
    [{ id: walletId }] = await db
      .insert(wallets)
      .values({ userId, groupId, name: "Cash", currency: "EUR" })
      .returning({ id: wallets.id });
    [{ id: categoryId }] = await db
      .insert(categories)
      .values({ userId, name: "Food", kind: "expense" })
      .returning({ id: categories.id });
  });

  const entry = (over: Partial<typeof transactions.$inferInsert> = {}) => ({
    userId,
    walletId,
    kind: "expense" as const,
    categoryId,
    amountMinor: 100,
    date: "2026-01-01",
    ...over,
  });

  it("transactions: kind, category and transfer must fit together (check 23514)", async () => {
    const [{ id: transferId }] = await db
      .insert(transfers)
      .values({ userId, date: "2026-01-01" })
      .returning({ id: transfers.id });
    expect(await sqlState(() => db.insert(transactions).values(entry()))).toBeNull();
    // an expense needs a category and no transfer
    expect(await sqlState(() => db.insert(transactions).values(entry({ categoryId: null })))).toBe("23514");
    expect(await sqlState(() => db.insert(transactions).values(entry({ transferId })))).toBe("23514");
    // a transfer leg needs a transfer and no category
    expect(await sqlState(() => db.insert(transactions).values(entry({ kind: "transfer_out" })))).toBe("23514");
    expect(
      await sqlState(() => db.insert(transactions).values(entry({ kind: "transfer_out", transferId, categoryId: null }))),
    ).toBeNull();
  });

  it("transactions: the amount must be positive", async () => {
    expect(await sqlState(() => db.insert(transactions).values(entry({ amountMinor: 0 })))).toBe("23514");
    expect(await sqlState(() => db.insert(transactions).values(entry({ amountMinor: -5 })))).toBe("23514");
  });

  it("transactions: amounts keep the 64-bit range", async () => {
    const big = Number.MAX_SAFE_INTEGER;
    await db.insert(transactions).values(entry({ amountMinor: big }));
    const [row] = await db.select({ n: transactions.amountMinor }).from(transactions);
    expect(row.n).toBe(big);
  });

  it("wallets: the currency has three characters; categories: the kind is expense or income", async () => {
    expect(await sqlState(() => db.insert(wallets).values({ userId, groupId, name: "X", currency: "EU" }))).toBe("23514");
    expect(await sqlState(() => db.insert(wallets).values({ userId, groupId, name: "X", currency: "EURO" }))).toBe("23514");
    expect(
      await sqlState(() =>
        db.execute(sql`insert into categories (user_id, name, kind) values (${userId}, 'Odd', 'transfer_in')`),
      ),
    ).toBe("23514");
  });

  it("unique indexes: user ID, email and category name per kind (23505)", async () => {
    expect(await sqlState(() => db.insert(users).values({ username: "u", passwordHash: "x" }))).toBe("23505");
    await db.insert(users).values({ username: "v", email: "v@x.test", passwordHash: "x" });
    expect(await sqlState(() => db.insert(users).values({ username: "w", email: "v@x.test", passwordHash: "x" }))).toBe("23505");
    // several accounts without an email do not collide
    expect(await sqlState(() => db.insert(users).values({ username: "z", passwordHash: "x" }))).toBeNull();
    expect(await sqlState(() => db.insert(categories).values({ userId, name: "Food", kind: "expense" }))).toBe("23505");
    expect(await sqlState(() => db.insert(categories).values({ userId, name: "Food", kind: "income" }))).toBeNull();
    // pgError finds the SQLSTATE and the constraint name, also behind Drizzle's wrapper
    try {
      await db.insert(users).values({ username: "u", passwordHash: "x" });
      expect.unreachable();
    } catch (err) {
      expect(pgError(err, "23505")?.constraint).toBe("users_username_unique");
    }
  });

  it("restrict: a group with wallets, a wallet with entries and a category in use cannot be deleted (23001, restrict_violation)", async () => {
    await db.insert(transactions).values(entry());
    expect(await sqlState(() => db.delete(walletGroups))).toBe("23001");
    expect(await sqlState(() => db.delete(wallets))).toBe("23001");
    expect(await sqlState(() => db.delete(categories))).toBe("23001");
  });

  it("cascade: deleting a transfer removes its legs; deleting a user removes everything they own", async () => {
    const [{ id: transferId }] = await db
      .insert(transfers)
      .values({ userId, date: "2026-01-01" })
      .returning({ id: transfers.id });
    await db.insert(transactions).values([
      entry({ kind: "transfer_out", transferId, categoryId: null }),
      entry({ kind: "transfer_in", transferId, categoryId: null }),
      entry(),
    ]);
    await db.delete(transfers);
    expect(await db.select().from(transactions)).toHaveLength(1);

    await db.insert(sessions).values({ tokenHash: "h", userId, expiresAt: new Date(Date.now() + 1000) });
    // The user delete cascades to every child table in one statement (restrict rules apply to the surviving rows only).
    await db.delete(users);
    for (const table of [sessions, transactions, transfers, wallets, categories, walletGroups]) {
      expect(await db.select().from(table)).toHaveLength(0);
    }
  });

  it("identity ids restart at 1 after a truncate", async () => {
    await db.execute(sql`truncate table users restart identity cascade`);
    const [row] = await db.insert(users).values({ username: "again", passwordHash: "x" }).returning({ id: users.id });
    expect(row.id).toBe(1);
  });
});

describe("database URL helpers", () => {
  it("masks the password", () => {
    expect(describeDatabase("postgres://expenses:s3cret@db:5432/expenses")).toBe("postgres://expenses:***@db:5432/expenses");
    expect(describeDatabase("postgres://expenses@db:5432/expenses")).toBe("postgres://expenses@db:5432/expenses");
    expect(describeDatabase("not a url")).not.toContain("not a url");
  });

  it("uses DATABASE_URL, falls back to the dev default outside production and refuses to guess in production", () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, DATABASE_URL: env.DATABASE_URL };
    try {
      expect(resolveDatabaseUrl("postgres://a:b@h/d")).toBe("postgres://a:b@h/d");
      delete env.DATABASE_URL;
      env.NODE_ENV = "development";
      expect(resolveDatabaseUrl()).toBe(DEFAULT_DEV_DATABASE_URL);
      env.NODE_ENV = "production";
      expect(() => resolveDatabaseUrl()).toThrow(/DATABASE_URL is not set/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
  });
});
