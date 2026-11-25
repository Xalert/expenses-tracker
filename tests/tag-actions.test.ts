// Tags through the Server Actions: the entry form's `tags` field (create, in-place update, errors echoed on `tags`),
// and the /categories Tags card (rename, merge, delete). Next's request APIs are mocked; the services run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTags } from "@/server/tags";
import { createTransaction, getTransaction, listTransactions } from "@/server/transactions";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const session = vi.hoisted(() => ({ userId: 0 }));
const next = vi.hoisted(() => ({ revalidated: [] as unknown[][] }));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.userId }) }));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    next.revalidated.push(args);
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));

const { createTransactionAction, updateTransactionInlineAction } = await import("@/app/(app)/transactions/actions");
const { renameTagAction, deleteTagAction } = await import("@/app/(app)/categories/actions");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

let user: Awaited<ReturnType<typeof makeUser>>;
let cash: number;

beforeEach(async () => {
  const db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  session.userId = user.id;
  next.revalidated = [];
  cash = (await createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
});

const expense = (extra: Record<string, string> = {}) =>
  fd({
    kind: "expense",
    walletId: String(cash),
    categoryId: String(user.cat("Food")),
    amount: "12.40",
    date: "2026-11-07",
    note: "",
    mode: "dialog",
    ...extra,
  });

describe("the entry form's tags field", () => {
  it("creates the entry with the comma-separated tags, making the new ones", async () => {
    const state = await createTransactionAction({}, expense({ tags: " holiday 2026, reimbursable ,holiday 2026" }));
    expect(state.ok).toBe(true);
    const [saved] = (await listTransactions(user.id)).items;
    expect(saved.tags).toEqual(["holiday 2026", "reimbursable"]);
    expect((await listTags(user.id)).map((t) => t.name)).toEqual(["holiday 2026", "reimbursable"]);
  });

  it("refuses more than 10 tags on the field `tags`, echoing what was typed and saving nothing", async () => {
    const typed = Array.from({ length: 11 }, (_, i) => `t${i}`).join(", ");
    const state = await createTransactionAction({}, expense({ tags: typed }));
    expect(state.ok).toBeUndefined();
    expect(state.fieldErrors?.tags).toBe("An entry can have at most 10 tags.");
    expect(state.values?.tags).toBe(typed);
    expect((await listTransactions(user.id)).total).toBe(0);
    expect(await listTags(user.id)).toEqual([]);
  });

  it("the in-place editor replaces the tags; a form without the field leaves them", async () => {
    const t = await createTransaction(user.id, {
      walletId: cash,
      kind: "expense",
      categoryId: user.cat("Food"),
      amountMinor: 100,
      date: "2026-11-07",
      tags: ["a", "b"],
    });
    const edit = (extra: Record<string, string>) =>
      updateTransactionInlineAction(t.id, {}, fd({ kind: "expense", walletId: String(cash), categoryId: String(user.cat("Food")), amount: "1.00", date: "2026-11-07", ...extra }));
    expect((await edit({ tags: "b, c" })).ok).toBe(true);
    expect((await getTransaction(user.id, t.id))!.tags).toEqual(["b", "c"]);
    expect((await edit({})).ok).toBe(true);
    expect((await getTransaction(user.id, t.id))!.tags).toEqual(["b", "c"]);
    expect((await edit({ tags: "" })).ok).toBe(true);
    expect((await getTransaction(user.id, t.id))!.tags).toEqual([]);
  });
});

describe("the Tags card's actions", () => {
  async function twoTags() {
    await createTransaction(user.id, { walletId: cash, kind: "expense", categoryId: user.cat("Food"), amountMinor: 100, date: "2026-11-07", tags: ["trip", "Work"] });
    await createTransaction(user.id, { walletId: cash, kind: "expense", categoryId: user.cat("Food"), amountMinor: 200, date: "2026-11-07", tags: ["trip"] });
    const tags = await listTags(user.id);
    return { trip: tags.find((t) => t.name === "trip")!, work: tags.find((t) => t.name === "Work")! };
  }

  it("renames, revalidating every page", async () => {
    const { trip } = await twoTags();
    expect(await renameTagAction(trip.id, {}, fd({ name: "Summer trip" }))).toEqual({ ok: true, message: "Renamed to “Summer trip”." });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect(await renameTagAction(trip.id, {}, fd({ name: "Summer trip" }))).toEqual({ ok: true, message: "Saved “Summer trip”." });
  });

  it("merges onto another tag's name and says so (merged: true)", async () => {
    const { trip, work } = await twoTags();
    expect(await renameTagAction(work.id, {}, fd({ name: "TRIP" }))).toEqual({ ok: true, merged: true, message: "Merged “Work” into “trip”." });
    expect((await listTags(user.id)).map((t) => [t.name, t.transactionCount])).toEqual([["trip", 2]]);
    expect(trip.id).toBe((await listTags(user.id))[0].id);
  });

  it("puts a bad name on the field `name` with the value echoed, and a missing tag as a message", async () => {
    const { trip } = await twoTags();
    const bad = await renameTagAction(trip.id, {}, fd({ name: "a, b" }));
    expect(bad.fieldErrors?.name).toBe("A tag name cannot contain a comma.");
    expect(bad.values?.name).toBe("a, b");
    expect((await renameTagAction(999_999, {}, fd({ name: "x" }))).message).toMatch(/Tag not found/);
  });

  it("deletes a tag from its entries, which stay", async () => {
    const { trip } = await twoTags();
    expect(await deleteTagAction(trip.id)).toEqual({ ok: true, message: "Deleted “trip” and took it off 2 entries." });
    expect((await listTransactions(user.id)).items.map((t) => t.tags)).toEqual([[], ["Work"]]);
    expect((await deleteTagAction(trip.id)).message).toMatch(/Tag not found/);
  });

  it("another user's tag is not found", async () => {
    const { trip } = await twoTags();
    const { getDb } = await import("@/db");
    session.userId = (await makeUser(await getDb(), "bob@example.com")).id;
    expect((await renameTagAction(trip.id, {}, fd({ name: "x" }))).message).toMatch(/Tag not found/);
    expect((await deleteTagAction(trip.id)).message).toMatch(/Tag not found/);
    session.userId = user.id;
    expect((await listTags(user.id)).map((t) => t.name)).toEqual(["trip", "Work"]);
  });
});
