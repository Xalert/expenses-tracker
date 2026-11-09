/**
 * The 0001 migration (user IDs) on databases that already hold data, and the migration runner in src/db/index.ts
 * that makes it safe: foreign keys off around the migrator, a foreign-key check afterwards, and a copy of the
 * database written before pending migrations touch an existing file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, migrateDatabase, pendingMigrations, schema, setDb, type DB } from "@/db";
import { hashPassword } from "@/lib/password";
import { USER_ID_RE } from "@/lib/user-id";
import { authenticateUser } from "@/server/users";

const MIGRATIONS = path.join(process.cwd(), "drizzle");
const TABLES = ["users", "sessions", "wallets", "categories", "transfers", "transactions"] as const;
const CHILD_TABLES = TABLES.filter((t) => t !== "users");

let tmp: string;
let PASSWORD_HASH: string;
const PASSWORD = "old-password";

beforeAll(async () => {
  PASSWORD_HASH = await hashPassword(PASSWORD);
});

afterEach(() => {
  setDb(undefined);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
  vi.restoreAllMocks();
});

function tempDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "et-migrate-"));
  return tmp;
}

/** A migrations folder holding only 0000_init, so drizzle records it exactly as an old install did. */
function initOnlyFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "et-0000-"));
  fs.mkdirSync(path.join(dir, "meta"));
  fs.copyFileSync(path.join(MIGRATIONS, "0000_init.sql"), path.join(dir, "0000_init.sql"));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag === "0000_init");
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

/** A migrations folder holding 0000 and 0001 only (the schema before wallet groups). */
function upTo0001Folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "et-0001-"));
  fs.mkdirSync(path.join(dir, "meta"));
  for (const f of ["0000_init.sql", "0001_user_ids.sql"]) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== "0002_wallet_groups");
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  return dir;
}

/** Open `file` (or memory) and bring it to migration 0000 only, as the previous release did (foreign keys on). */
function openAt0000(file = ":memory:"): Database.Database {
  const sqlite = new Database(file);
  if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const folder = initOnlyFolder();
  try {
    migrate(drizzle({ client: sqlite }), { migrationsFolder: folder });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return sqlite;
}

type OldUser = { id: number; email: string; name: string };

/** Awkward accounts from before user IDs existed. */
const OLD_USERS: OldUser[] = [
  { id: 1, email: "plain@example.com", name: "Ana" },
  { id: 2, email: "UPPER.Case@Example.COM", name: "Bob Stone" },
  { id: 3, email: "first.last+tag@mail.example", name: "Ana Maria Pop" },
  { id: 4, email: "o'neil!#$%&*=?^`{|}~@x.org", name: "  Spaced Out  " },
  { id: 5, email: "plain@other.org", name: "Jean  Luc" }, // same local part as #1, other domain
  { id: 6, email: "+++@x.com", name: "Solo " }, // sanitises to nothing valid
  { id: 7, email: "ab@x.com", name: "Short Local" }, // too short to be a user ID
  { id: 8, email: "._-lead@x.com", name: "Lead Punct" },
  { id: 9, email: "a-very-long-local-part-that-exceeds-thirty-two-chars@x.com", name: "Long One" },
  { id: 10, email: "a-very-long-local-part-that-exceeds-thirty-two-chars-too@y.com", name: "Long Two" },
  { id: 11, email: "ünïcode@x.com", name: "Ü Ñ" },
];

/** Every user gets two wallets, two categories, an expense, an income, a transfer (both legs) and a session. */
function insertOldData(sqlite: Database.Database, opts: { transactions?: boolean } = {}) {
  const withTx = opts.transactions ?? true;
  const insert = sqlite.transaction(() => {
    for (const u of OLD_USERS) {
      sqlite
        .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(u.id, u.email, u.name, PASSWORD_HASH, 1_700_000_000 + u.id);
      const w1 = Number(
        sqlite
          .prepare("INSERT INTO wallets (user_id, name, currency, initial_balance_minor, created_at) VALUES (?, 'Main', 'EUR', ?, 1)")
          .run(u.id, u.id * 100).lastInsertRowid,
      );
      const w2 = Number(
        sqlite
          .prepare("INSERT INTO wallets (user_id, name, currency, archived_at, created_at) VALUES (?, 'Cash', 'USD', ?, 1)")
          .run(u.id, u.id % 2 ? 5 : null).lastInsertRowid,
      );
      const ce = Number(
        sqlite.prepare("INSERT INTO categories (user_id, name, kind, created_at) VALUES (?, 'Food', 'expense', 1)").run(u.id)
          .lastInsertRowid,
      );
      const ci = Number(
        sqlite.prepare("INSERT INTO categories (user_id, name, kind, created_at) VALUES (?, 'Salary', 'income', 1)").run(u.id)
          .lastInsertRowid,
      );
      sqlite
        .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, 1)")
        .run(`token-${u.id}`, u.id, 4_000_000_000);
      if (!withTx) continue;
      const add = sqlite.prepare(
        "INSERT INTO transactions (user_id, wallet_id, kind, category_id, amount_minor, date, note, transfer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      );
      add.run(u.id, w1, "expense", ce, 1250 + u.id, "2026-01-05", `lunch ${u.id}`, null);
      add.run(u.id, w1, "income", ci, 300000, "2026-01-01", null, null);
      const t = Number(
        sqlite.prepare("INSERT INTO transfers (user_id, date, note, created_at) VALUES (?, '2026-01-10', 'ATM', 1)").run(u.id)
          .lastInsertRowid,
      );
      add.run(u.id, w1, "transfer_out", null, 5000, "2026-01-10", "ATM", t);
      add.run(u.id, w2, "transfer_in", null, 5400, "2026-01-10", "ATM", t);
    }
  });
  insert();
}

function snapshot(sqlite: Database.Database) {
  return Object.fromEntries(
    TABLES.map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all() as Record<string, unknown>[]]),
  ) as Record<(typeof TABLES)[number], Record<string, unknown>[]>;
}

function counts(sqlite: Database.Database) {
  return Object.fromEntries(
    TABLES.map((t) => [t, (sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );
}

/** The rule from docs/SPEC.md "Migration of existing accounts", written independently of the SQL. */
function expectedUsernames(rows: { id: number; email: string }[]): Map<number, string> {
  const bases = [...rows]
    .sort((a, b) => a.id - b.id)
    .map((r) => {
      const local = r.email.slice(0, r.email.indexOf("@")).toLowerCase();
      const cleaned = [...local]
        .map((c) => (/[a-z0-9._-]/.test(c) ? c : "-"))
        .join("")
        .replace(/^[._-]+/, "")
        .slice(0, 32);
      return { id: r.id, base: cleaned.length >= 3 ? cleaned : `user${r.id}` };
    });
  const out = new Map<number, string>();
  const seen = new Set<string>();
  for (const { id, base } of bases) {
    const suffix = `-${id}`;
    const name = seen.has(base) ? base.slice(0, 32 - suffix.length) + suffix : base;
    seen.add(base);
    out.set(id, name);
  }
  // A suffixed name equal to an earlier account's plain one falls back to user<id>.
  const used = new Set<string>();
  for (const { id } of bases) {
    if (used.has(out.get(id)!)) out.set(id, `user${id}`);
    used.add(out.get(id)!);
  }
  return out;
}

/** Runs the migration runner; `through0001` stops before 0002 (the tests of 0001 compare the old wallets table). */
function runRunner(sqlite: Database.Database, file = ":memory:", through0001 = false) {
  const db = drizzle({ client: sqlite, schema }) as DB;
  const folder = through0001 ? upTo0001Folder() : undefined;
  try {
    return { db, result: migrateDatabase(db, { file, migrationsFolder: folder }) };
  } finally {
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  }
}

describe("0001 user IDs on a populated database", () => {
  it("keeps every row and every owner, derives user IDs and splits names", async () => {
    const sqlite = openAt0000();
    insertOldData(sqlite);
    const before = snapshot(sqlite);
    expect(before.transactions).toHaveLength(OLD_USERS.length * 4);

    const { db, result } = runRunner(sqlite, ":memory:", true);
    expect(result).toEqual({ applied: ["0001_user_ids"], backupPath: null });
    const after = snapshot(sqlite);

    // Nothing lost and nothing re-pointed: every non-user table is byte-for-byte the same.
    expect(counts(sqlite)).toEqual(Object.fromEntries(TABLES.map((t) => [t, before[t].length])));
    for (const t of CHILD_TABLES) expect(after[t]).toEqual(before[t]);

    // users: same ids, emails, hashes and timestamps; new columns derived.
    expect(Object.keys(after.users[0]).sort()).toEqual(
      ["created_at", "email", "first_name", "id", "last_name", "password_hash", "username"].sort(),
    );
    const expected = expectedUsernames(OLD_USERS);
    for (const old of before.users) {
      const now = after.users.find((u) => u.id === old.id)!;
      expect(now).toMatchObject({
        email: old.email,
        password_hash: old.password_hash,
        created_at: old.created_at,
        username: expected.get(old.id as number),
      });
    }
    const usernames = after.users.map((u) => u.username as string);
    expect(new Set(usernames).size).toBe(usernames.length);
    for (const u of usernames) expect(u).toMatch(USER_ID_RE);

    // The derivation, spelled out for the awkward cases.
    const byId = new Map(after.users.map((u) => [u.id as number, u]));
    expect([...byId.values()].map((u) => [u.id, u.username, u.first_name, u.last_name])).toEqual([
      [1, "plain", "Ana", null],
      [2, "upper.case", "Bob", "Stone"],
      [3, "first.last-tag", "Ana", "Maria Pop"],
      [4, "o-neil--------------", "Spaced", "Out"],
      [5, "plain-5", "Jean", "Luc"],
      [6, "user6", "Solo", null],
      [7, "user7", "Short", "Local"],
      [8, "lead", "Lead", "Punct"],
      [9, "a-very-long-local-part-that-exce", "Long", "One"],
      [10, "a-very-long-local-part-that-e-10", "Long", "Two"],
      [11, "n-code", "Ü", "Ñ"],
    ]);

    // Foreign keys are enforced again and nothing dangles.
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(pendingMigrations(db)).toEqual(["0002_wallet_groups"]);

    // Migrated accounts sign in with their old email (any case) and with their derived user ID.
    setDb(db);
    expect(await authenticateUser("UPPER.Case@Example.COM", PASSWORD)).toMatchObject({ id: 2, username: "upper.case" });
    expect(await authenticateUser("upper.case@example.com", PASSWORD)).toMatchObject({ id: 2 });
    expect(await authenticateUser("Upper.Case", PASSWORD)).toMatchObject({ id: 2, displayName: "Bob Stone" });
    expect(await authenticateUser("plain-5", PASSWORD)).toMatchObject({ id: 5, email: "plain@other.org" });
    expect(await authenticateUser("plain@other.org", PASSWORD)).toMatchObject({ id: 5 });
    expect(await authenticateUser("user6", PASSWORD)).toMatchObject({ id: 6, displayName: "Solo" });
    expect(await authenticateUser("plain", "wrong-password")).toBeNull();
  });

  it("still cascades from users after the rebuild (the children point at the new table)", () => {
    const sqlite = openAt0000();
    insertOldData(sqlite, { transactions: false });
    runRunner(sqlite);
    sqlite.prepare("DELETE FROM users WHERE id = 1").run();
    expect(sqlite.prepare("SELECT count(*) AS n FROM wallets WHERE user_id = 1").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM wallets").get()).toEqual({ n: (OLD_USERS.length - 1) * 2 });
  });

  it("falls back to user<id> when a suffixed user ID equals another account's plain one", () => {
    const sqlite = openAt0000();
    const add = sqlite.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'X', 'h', 1)");
    add.run(2, "bob@a.com");
    add.run(5, "bob@b.com"); // → bob-5
    add.run(9, "bob-5@c.com"); // plain bob-5 is now taken by #5 → user9
    runRunner(sqlite);
    expect(sqlite.prepare("SELECT id, username FROM users ORDER BY id").all()).toEqual([
      { id: 2, username: "bob" },
      { id: 5, username: "bob-5" },
      { id: 9, username: "user9" },
    ]);
    expect(expectedUsernames([
      { id: 2, email: "bob@a.com" },
      { id: 5, email: "bob@b.com" },
      { id: 9, email: "bob-5@c.com" },
    ])).toEqual(new Map([[2, "bob"], [5, "bob-5"], [9, "user9"]]));
  });
});

describe("0002 wallet groups on a populated database", () => {
  /** A database at 0001 (data written at 0000, then migrated), with one extra user without wallets. */
  function populatedAt0001() {
    const sqlite = openAt0000();
    insertOldData(sqlite);
    sqlite
      .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (50, 'empty@x.com', 'No Wallets', 'h', 1)")
      .run();
    runRunner(sqlite, ":memory:", true);
    return sqlite;
  }

  it("gives every user a Personal group and every wallet its owner's group, losing and changing nothing else", () => {
    const sqlite = populatedAt0001();
    const before = snapshot(sqlite);
    expect(before.wallets).toHaveLength(OLD_USERS.length * 2);
    expect(Object.keys(before.wallets[0])).not.toContain("group_id");
    const archivedBefore = before.wallets.filter((w) => w.archived_at !== null).length;
    expect(archivedBefore).toBeGreaterThan(0);

    const { db, result } = runRunner(sqlite);
    expect(result).toEqual({ applied: ["0002_wallet_groups"], backupPath: null });
    const after = snapshot(sqlite);

    // Untouched tables are identical.
    for (const t of ["users", "sessions", "categories", "transfers", "transactions"] as const) {
      expect(after[t]).toEqual(before[t]);
    }
    expect(counts(sqlite)).toMatchObject(Object.fromEntries(TABLES.map((t) => [t, before[t].length])));

    // Wallets: same ids and every old column; only group_id is new.
    expect(after.wallets).toHaveLength(before.wallets.length);
    for (const old of before.wallets) {
      const now = after.wallets.find((w) => w.id === old.id)!;
      const { group_id: groupId, ...rest } = now;
      expect(rest).toEqual(old);
      expect(groupId).toEqual(expect.any(Number));
    }

    // One Personal group per user (including the user without wallets); each wallet is in its owner's.
    const groups = sqlite.prepare("SELECT id, user_id, name, created_at FROM wallet_groups ORDER BY id").all() as {
      id: number;
      user_id: number;
      name: string;
      created_at: number;
    }[];
    expect(groups.map((g) => g.user_id)).toEqual(after.users.map((u) => u.id));
    expect(groups.every((g) => g.name === "Personal" && g.created_at > 1_700_000_000)).toBe(true);
    const groupOwner = new Map(groups.map((g) => [g.id, g.user_id]));
    for (const w of after.wallets) expect(groupOwner.get(w.group_id as number)).toBe(w.user_id);

    // Foreign keys are back on and consistent, and the new constraints work.
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(pendingMigrations(db)).toEqual([]);
    expect(() => sqlite.prepare("DELETE FROM wallet_groups WHERE id = ?").run(groups[0].id)).toThrow(/FOREIGN KEY/);
    sqlite.prepare("DELETE FROM users WHERE id = 50").run();
    expect(sqlite.prepare("SELECT count(*) AS n FROM wallet_groups WHERE user_id = 50").get()).toEqual({ n: 0 });
  });

  it("refuses to drop a wallet whose owner is missing: the migration fails and is rolled back", () => {
    const sqlite = populatedAt0001();
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare("INSERT INTO wallets (user_id, name, currency, created_at) VALUES (999, 'Orphan', 'EUR', 1)").run();
    sqlite.pragma("foreign_keys = ON");
    const before = snapshot(sqlite);
    expect(() => runRunner(sqlite)).toThrow(/Database migration failed[\s\S]*NOT NULL/);
    expect(snapshot(sqlite)).toEqual(before);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'wallet_groups'").all()).toEqual([]);
  });
});

describe("a migration that fails", () => {
  it("is rolled back as a whole, and startup reports it with the backup's location", () => {
    const file = path.join(tempDir(), "app.db");
    const old = openAt0000(file);
    const add = old.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, 'X', 'h', 1)");
    add.run(2, "bob@a.com");
    add.run(5, "bob@b.com"); // bob-5
    add.run(9, "bob-5@c.com"); // → user9 …
    add.run(10, "user9@d.com"); // … which #10 already has: the unique index refuses
    old.prepare("INSERT INTO wallets (user_id, name, currency, created_at) VALUES (9, 'W', 'EUR', 1)").run();
    old.close();
    vi.spyOn(console, "info").mockImplementation(() => {});

    expect(() => createDatabase(file)).toThrow(
      /Database migration failed: .*UNIQUE constraint failed: users\.username.*rolled back.*before-migration-0001_user_ids\.bak/,
    );
    const after = new Database(file, { readonly: true });
    expect((after.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name)).toContain("name");
    expect(counts(after)).toMatchObject({ users: 4, wallets: 1 });
    after.close();
  });
});

describe("why the runner switches foreign keys off (the hazard)", () => {
  // Without the runner, migrations ran on a connection with foreign keys ON, and drizzle's migrator wraps them in
  // BEGIN … COMMIT — so the `PRAGMA foreign_keys=OFF` that drizzle-kit writes into the file is silently ignored.
  // `DROP TABLE users` then performs an implicit `DELETE FROM users`, which fires ON DELETE CASCADE on sessions,
  // wallets, categories, transfers and transactions.

  it("with no transactions at all: silently deletes every wallet, category and session", () => {
    const sqlite = openAt0000(); // foreign keys ON, as createDatabase used to leave them
    insertOldData(sqlite, { transactions: false });
    const before = counts(sqlite);
    expect(before).toMatchObject({ wallets: 22, categories: 22, sessions: 11 });

    migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS }); // succeeds…
    expect(counts(sqlite)).toEqual({ ...before, wallets: 0, categories: 0, sessions: 0 }); // …and the data is gone
  });

  it("with transactions: the cascade hits RESTRICT, so the migration fails and is rolled back (no loss, no startup)", () => {
    const sqlite = openAt0000();
    insertOldData(sqlite);
    const before = snapshot(sqlite);

    // The cascade reaches wallets before transactions; transactions.wallet_id is ON DELETE RESTRICT.
    let error: unknown;
    try {
      migrate(drizzle({ client: sqlite }), { migrationsFolder: MIGRATIONS });
    } catch (err) {
      error = err;
    }
    expect((error as Error).message).toMatch(/DROP TABLE `users`/);
    expect(((error as Error).cause as Error).message).toBe("FOREIGN KEY constraint failed");
    expect(snapshot(sqlite)).toEqual(before); // rolled back: still the 0000 schema, nothing lost — but the app can't start
  });

  it("the runner migrates the same databases without losing anything", () => {
    for (const transactions of [false, true]) {
      const sqlite = openAt0000();
      insertOldData(sqlite, { transactions });
      const before = counts(sqlite);
      runRunner(sqlite);
      expect(counts(sqlite)).toEqual(before);
    }
  });
});

describe("pre-migration backup", () => {
  it("copies a populated file database before applying a pending migration", () => {
    const file = path.join(tempDir(), "app.db");
    const old = openAt0000(file);
    insertOldData(old);
    const before = snapshot(old);
    old.close();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const db = createDatabase(file);
    const backup = `${file}.before-migration-0001_user_ids.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringContaining(backup));

    // The copy is a valid database with the old schema and the old data.
    const copy = new Database(backup, { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((copy.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name)).toContain("name");
    expect(snapshot(copy)).toEqual(before);
    expect(copy.prepare('SELECT count(*) AS n FROM "__drizzle_migrations"').get()).toEqual({ n: 1 });
    copy.close();

    // The live database is migrated.
    expect(counts(db.$client)).toEqual(Object.fromEntries(TABLES.map((t) => [t, before[t].length])));
    db.$client.close();

    // Starting again with nothing pending writes no further copy.
    const again = createDatabase(file);
    again.$client.close();
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".bak"))).toEqual([path.basename(backup)]);
  });

  it("never overwrites an earlier copy", () => {
    const file = path.join(tempDir(), "app.db");
    const old = openAt0000(file);
    insertOldData(old, { transactions: false });
    old.close();
    fs.writeFileSync(`${file}.before-migration-0001_user_ids.bak`, "earlier");
    vi.spyOn(console, "info").mockImplementation(() => {});

    createDatabase(file).$client.close();
    expect(fs.readFileSync(`${file}.before-migration-0001_user_ids.bak`, "utf8")).toBe("earlier");
    const copies = fs.readdirSync(tmp).filter((f) => f.endsWith(".bak"));
    expect(copies).toHaveLength(2);
    expect(copies.find((f) => f !== "app.db.before-migration-0001_user_ids.bak")).toMatch(
      /^app\.db\.before-migration-0001_user_ids\.\d{4}-.*\.bak$/,
    );
  });

  it("writes nothing for a brand-new file, for :memory:, or when up to date", () => {
    const file = path.join(tempDir(), "new.db");
    const fresh = createDatabase(file);
    fresh.$client.close();
    expect(fs.readdirSync(tmp).filter((f) => f.includes(".bak"))).toEqual([]);

    const again = createDatabase(file);
    expect(migrateDatabase(again, { file })).toEqual({ applied: [], backupPath: null });
    again.$client.close();
    expect(fs.readdirSync(tmp).filter((f) => f.includes(".bak"))).toEqual([]);

    const mem = openAt0000();
    insertOldData(mem, { transactions: false });
    expect(runRunner(mem).result).toEqual({ applied: ["0001_user_ids", "0002_wallet_groups"], backupPath: null });
  });
});

describe("foreign-key check after migrating", () => {
  it("refuses to start when a row points at something that does not exist", () => {
    const file = path.join(tempDir(), "app.db");
    const old = openAt0000(file);
    insertOldData(old, { transactions: false });
    old.pragma("foreign_keys = OFF");
    old.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('orphan', 999, 1, 1)").run();
    old.close();
    vi.spyOn(console, "info").mockImplementation(() => {});

    expect(() => createDatabase(file)).toThrow(
      /integrity check failed: 1 row\(s\).*sessions row \d+ → missing users.*before-migration-0001_user_ids\.bak/,
    );
  });

  it("also runs when nothing is pending", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle({ client: sqlite, schema }) as DB;
    migrateDatabase(db, { file: ":memory:" });
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('t', 42, 1, 1)").run();
    expect(() => migrateDatabase(db, { file: ":memory:" })).toThrow(/integrity check failed/);
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
