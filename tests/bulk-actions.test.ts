// The bulk bar's Server Action (`bulkEditAction`): Delete asks first with the server's counts, the confirmed counts
// guard the delete, the other actions redirect to the list without selection mode and with the outcome in `?done=`,
// errors land on their fields with the selection echoed, and "all matching" re-reads the list's filters.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeOutcome } from "@/lib/bulk-result";
import { archiveCategory } from "@/server/categories";
import { createTransaction, getTransaction, listTransactions } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const session = vi.hoisted(() => ({ userId: 0 }));
const next = vi.hoisted(() => ({ revalidated: [] as unknown[][] }));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.userId, timeZone: "UTC" }) }));
vi.mock("@/lib/group-scope", () => ({ getGroupScope: async () => ({ groups: [], archivedGroups: [], selected: null }) }));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    next.revalidated.push(args);
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const { bulkEditAction } = await import("@/app/(app)/transactions/bulk-actions");

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

let user: Awaited<ReturnType<typeof makeUser>>;
let cash: number;
let ids: number[];

beforeEach(async () => {
  const db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  session.userId = user.id;
  next.revalidated = [];
  cash = (await createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
  const add = (note: string, date = "2026-11-05") =>
    createTransaction(user.id, { walletId: cash, kind: "expense", categoryId: user.cat("Food"), amountMinor: 500, date, note });
  ids = [(await add("a")).id, (await add("b")).id, (await add("c", "2026-10-01")).id];
});

const LIST = "month=2026-11&q=x&select=1";

describe("bulkEditAction", () => {
  it("Delete answers with the server's counts first, then deletes once confirmed and redirects with the outcome", async () => {
    const first = await bulkEditAction({}, fd([["op", "delete"], ["ids", String(ids[0])], ["ids", String(ids[1])], ["list", LIST]]));
    expect(first.confirm).toEqual({ entries: 2, transfers: 0, all: false });
    expect(first.selectedIds).toEqual([ids[0], ids[1]]);
    expect((await listTransactions(user.id)).total).toBe(3);

    const url = await redirectOf(
      bulkEditAction(first, fd([["op", "delete"], ["ids", String(ids[0])], ["ids", String(ids[1])], ["list", LIST], ["confirmed", "2:0"]])),
    );
    // Back to the list: selection mode off, page 1, the outcome in `done`.
    expect(url).toBe("/transactions?month=2026-11&q=x&done=d.2.0");
    expect(decodeOutcome("d.2.0")).toEqual({ op: "delete", entries: 2, transfers: 0 });
    expect((await listTransactions(user.id)).total).toBe(1);
    expect(next.revalidated).toContainEqual(["/", "layout"]);
  });

  it("asks again when the confirmed counts no longer match", async () => {
    const state = await bulkEditAction({}, fd([["op", "delete"], ["ids", String(ids[0])], ["confirmed", "5:0"]]));
    expect(state.confirm).toEqual({ entries: 1, transfers: 0, all: false });
    expect(state.message).toMatch(/changed since you confirmed/);
    expect((await listTransactions(user.id)).total).toBe(3);
  });

  it("a transfer leg counts as its transfer", async () => {
    const yen = (await createWallet(user.id, { name: "Yen", currency: "JPY", initialBalanceMinor: 0 })).id;
    const t = await createTransfer(user.id, { fromWalletId: cash, toWalletId: yen, amountMinor: 100, receivedAmountMinor: 16, date: "2026-11-05" });
    const leg = (await listTransactions(user.id, { kind: "transfer" })).items[0];
    const state = await bulkEditAction({}, fd([["op", "delete"], ["ids", String(leg.id)], ["ids", String(ids[0])]]));
    expect(state.confirm).toEqual({ entries: 1, transfers: 1, all: false });
    expect(t.id).toBeGreaterThan(0);
  });

  it("all matching: the list's filters, re-evaluated on the server", async () => {
    const state = await bulkEditAction({}, fd([["op", "delete"], ["scope", "all"], ["list", "month=2026-11"]]));
    expect(state.confirm).toEqual({ entries: 2, transfers: 0, all: true });
    const url = await redirectOf(
      bulkEditAction(state, fd([["op", "category"], ["scope", "all"], ["list", "month=2026-11"], ["categoryId", String(user.cat("Groceries"))]])),
    );
    expect(url).toBe(`/transactions?month=2026-11&done=c.${user.cat("Groceries")}.2.0.0.0`);
    expect((await getTransaction(user.id, ids[2]))!.categoryName).toBe("Food");
    // An invalid amount bound in the list is not silently dropped for "all matching".
    const bad = await bulkEditAction({}, fd([["op", "delete"], ["scope", "all"], ["list", "min=-1"]]));
    expect(bad.message).toMatch(/Fix the amount filter first/);
  });

  it("errors land on their fields with the selection and values echoed", async () => {
    await archiveCategory(user.id, user.cat("Groceries"));
    const archived = await bulkEditAction(
      {},
      fd([["op", "category"], ["ids", String(ids[0])], ["categoryId", String(user.cat("Groceries"))]]),
    );
    expect(archived.fieldErrors?.categoryId).toMatch(/archived/);
    expect(archived.selectedIds).toEqual([ids[0]]);
    expect(archived.values).toMatchObject({ op: "category", categoryId: String(user.cat("Groceries")) });

    const badTag = await bulkEditAction({}, fd([["op", "addTag"], ["ids", String(ids[0])], ["tagName", "a,b"]]));
    expect(badTag.fieldErrors?.tagName).toBeTruthy();
    expect(badTag.values?.tagName).toBe("a,b");

    expect((await bulkEditAction({}, fd([["op", "removeTag"], ["ids", String(ids[0])]]))).fieldErrors?.tagId).toBe("Choose a tag.");
    expect((await bulkEditAction({}, fd([["op", "nope"], ["ids", String(ids[0])]]))).fieldErrors?.op).toBeTruthy();
    expect((await bulkEditAction({}, fd([["op", "delete"]]))).message).toMatch(/Tick at least one entry/);
  });

  it("Cancel drops the pending confirmation and keeps the selection", async () => {
    const state = await bulkEditAction({ confirm: { entries: 1, transfers: 0, all: false } }, fd([["op", "delete"], ["ids", String(ids[0])], ["intent", "cancel"]]));
    expect(state.confirm).toBeUndefined();
    expect(state.selectedIds).toEqual([ids[0]]);
  });

  it("Add tag redirects with the tag's id and counts", async () => {
    const url = await redirectOf(bulkEditAction({}, fd([["op", "addTag"], ["ids", String(ids[0])], ["ids", String(ids[1])], ["tagName", "trip"]])));
    const done = decodeOutcome(new URL(url, "http://x").searchParams.get("done") ?? "");
    expect(done).toMatchObject({ op: "addTag", added: 2, already: 0, atLimit: 0, transfers: 0 });
    expect((await getTransaction(user.id, ids[0]))!.tags).toEqual(["trip"]);
  });
});
