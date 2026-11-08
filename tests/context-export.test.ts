// The "Wallets & categories" context export (GET /api/export/context): wallets and categories only, for companion
// tools such as the Statement Importer artifact.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { categories } from "@/db/schema";
import type { CurrentUser } from "@/lib/auth";
import { contextSchema } from "@/lib/context-format";
import { buildContext } from "@/server/export";
import { createCategory } from "@/server/categories";
import { createTransaction } from "@/server/transactions";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

// Route handlers read the session through getCurrentUser (next/headers); tests decide who is signed in.
const session = vi.hoisted(() => ({ user: null as CurrentUser | null }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => session.user }));

const { GET } = await import("@/app/api/export/context/route");

const NOW = new Date("2026-11-08T09:30:00.000Z");
let db: ReturnType<typeof useFreshDb>;

beforeEach(() => {
  db = useFreshDb();
  session.user = null;
});

function seed() {
  const alice = makeUser(db, "alice@example.com");
  const main = createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 100_000 });
  createWallet(alice.id, { name: "Tokyo", currency: "JPY", initialBalanceMinor: 30_000 });
  const old = createWallet(alice.id, { name: "Old card", currency: "USD", initialBalanceMinor: 0 });
  archiveWallet(alice.id, old.id);
  createCategory(alice.id, { name: "Pets", kind: "expense" });
  createTransaction(alice.id, { walletId: main.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 1_250, date: "2026-11-01", note: "secret note" });
  return alice;
}

describe("buildContext", () => {
  it("returns exactly the spec's shape: wallets with archived flag, categories with kind, nothing else", () => {
    const alice = seed();
    const ctx = buildContext(alice.id, NOW);

    expect(Object.keys(ctx).sort()).toEqual(["app", "categories", "exportedAt", "kind", "version", "wallets"]);
    expect(ctx).toMatchObject({ app: "expenses-tracker", kind: "context", version: 1, exportedAt: "2026-11-08T09:30:00.000Z" });
    expect(ctx.wallets).toEqual([
      { name: "Main", currency: "EUR", archived: false },
      { name: "Tokyo", currency: "JPY", archived: false },
      { name: "Old card", currency: "USD", archived: true },
    ]);
    for (const c of ctx.categories) expect(Object.keys(c).sort()).toEqual(["kind", "name"]);
    expect(ctx.categories).toContainEqual({ name: "Pets", kind: "expense" });
    expect(ctx.categories).toContainEqual({ name: "Salary", kind: "income" });
    // No ids, balances, notes or transactions anywhere in the file.
    const json = JSON.stringify(ctx);
    expect(json).not.toMatch(/"id"|Minor|balance|secret note|transactions|alice/i);
  });

  it("is scoped to the user", () => {
    seed();
    const bob = makeUser(db, "bob@example.com");
    createWallet(bob.id, { name: "Bob's", currency: "GBP", initialBalanceMinor: 0 });
    const ctx = buildContext(bob.id, NOW);
    expect(ctx.wallets).toEqual([{ name: "Bob's", currency: "GBP", archived: false }]);
    expect(ctx.categories).not.toContainEqual({ name: "Pets", kind: "expense" });
  });

  it("gives empty lists for an empty account", () => {
    const empty = makeUser(db, "empty@example.com");
    db.delete(categories).where(eq(categories.userId, empty.id)).run();
    expect(buildContext(empty.id, NOW)).toEqual({
      app: "expenses-tracker",
      kind: "context",
      version: 1,
      exportedAt: "2026-11-08T09:30:00.000Z",
      wallets: [],
      categories: [],
    });
  });

  it("is accepted by its own zod schema, which ignores unknown fields and rejects other kinds", () => {
    const alice = seed();
    const ctx = buildContext(alice.id, NOW);
    expect(contextSchema.parse(JSON.parse(JSON.stringify(ctx)))).toEqual(ctx);
    expect(contextSchema.parse({ ...ctx, extra: 1, wallets: [{ ...ctx.wallets[0], id: 9 }] }).wallets).toEqual([ctx.wallets[0]]);
    expect(contextSchema.safeParse({ ...ctx, kind: "backup" }).success).toBe(false);
    expect(contextSchema.safeParse({ ...ctx, version: 2 }).success).toBe(false);
    expect(contextSchema.safeParse({ ...ctx, categories: [{ name: "X", kind: "transfer" }] }).success).toBe(false);
  });
});

describe("GET /api/export/context", () => {
  it("answers 401 when signed out", async () => {
    seed();
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Sign in to export your data." });
  });

  it("downloads the signed-in user's context as pretty-printed JSON", async () => {
    const alice = seed();
    session.user = { id: alice.id, username: "alice", email: null, firstName: null, lastName: null, displayName: "alice" };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="expenses-tracker-context-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toMatch(/^\{\n  "app": "expenses-tracker",\n  "kind": "context",/);
    expect(text.endsWith("}\n")).toBe(true);
    const body = contextSchema.parse(JSON.parse(text));
    expect(body.wallets.map((w) => w.name)).toEqual(["Main", "Tokyo", "Old card"]);
  });
});
