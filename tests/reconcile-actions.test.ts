// reconcileWalletAction (the wallet page's "Reconcile balance" form): parsing in the wallet's currency, errors on the
// right field with the values echoed, the confirmation, and revalidation. Next's request APIs are mocked; the services
// run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseReconcile } from "@/app/(app)/wallets/form-input";
import { addDays, todayInZone } from "@/lib/dates";
import { archiveWallet, createWallet, getWallet } from "@/server/wallets";
import { listTransactions } from "@/server/transactions";
import { makeUser, useFreshDb } from "./helpers";

const session = vi.hoisted(() => ({ userId: 0 }));
const next = vi.hoisted(() => ({ revalidated: [] as unknown[][] }));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.userId, timeZone: "UTC" }) }));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    next.revalidated.push(args);
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`unexpected redirect ${url}`);
  },
}));

const { reconcileWalletAction } = await import("@/app/(app)/wallets/actions");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

let user: Awaited<ReturnType<typeof makeUser>>;
const today = () => todayInZone("UTC");

beforeEach(async () => {
  const db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  session.userId = user.id;
  next.revalidated = [];
});

describe("reconcileWalletAction", () => {
  it("records the difference, revalidates every page and confirms what was added", async () => {
    const w = await createWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    const state = await reconcileWalletAction(w.id, {}, fd({ actualBalance: "987,60", date: today() }));
    expect(state.ok).toBe(true);
    expect(state.message).toMatch(/^Added an expense of €12\.40 on .+ in “Balance adjustment”\. The balance on that day is now €987\.60\.$/);
    expect(state.values).toEqual({ date: today() });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect((await getWallet(user.id, w.id))!.balanceMinor).toBe(98_760);
  });

  it("parses in the wallet's currency: whole yen, three-decimal dinars, negatives", async () => {
    const yen = await createWallet(user.id, { name: "Yen", currency: "JPY", initialBalanceMinor: 0 });
    expect((await reconcileWalletAction(yen.id, {}, fd({ actualBalance: "1 500", date: today() }))).message).toMatch(
      /^Added income of ¥1,500 /,
    );
    const tooFine = await reconcileWalletAction(yen.id, {}, fd({ actualBalance: "10.5", date: today() }));
    expect(tooFine.fieldErrors?.actualBalance).toMatch(/whole amount in JPY/);
    const kwd = await createWallet(user.id, { name: "Dinar", currency: "KWD", initialBalanceMinor: 0 });
    await reconcileWalletAction(kwd.id, {}, fd({ actualBalance: "-1.234", date: today() }));
    expect((await getWallet(user.id, kwd.id))!.balanceMinor).toBe(-1_234);
  });

  it("says when the balance already matches and records nothing", async () => {
    const w = await createWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 5_000 });
    const state = await reconcileWalletAction(w.id, {}, fd({ actualBalance: "50", date: today() }));
    expect(state).toMatchObject({ ok: true, message: expect.stringMatching(/^The balance already matches €50\.00 on .+\. Nothing was added\.$/) });
    expect((await listTransactions(user.id, { walletId: w.id })).total).toBe(0);
  });

  it("puts errors on the right field and echoes the values", async () => {
    const w = await createWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    const empty = await reconcileWalletAction(w.id, {}, fd({ actualBalance: " ", date: today() }));
    expect(empty).toMatchObject({
      fieldErrors: { actualBalance: "Enter the wallet's actual balance." },
      values: { actualBalance: " ", date: today() },
    });
    const future = addDays(today(), 1);
    const later = await reconcileWalletAction(w.id, {}, fd({ actualBalance: "12", date: future }));
    expect(later).toEqual({
      fieldErrors: { date: "Choose today or an earlier date." },
      values: { actualBalance: "12", date: future },
    });
    expect(next.revalidated).toEqual([]);
  });

  it("refuses an archived wallet with a form-level message", async () => {
    const w = await createWallet(user.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 });
    await archiveWallet(user.id, w.id);
    const state = await reconcileWalletAction(w.id, {}, fd({ actualBalance: "1", date: today() }));
    expect(state).toEqual({ message: "This wallet is archived.", values: { actualBalance: "1", date: today() } });
  });

  it("another user's wallet is not found", async () => {
    const db = await import("@/db").then((m) => m.getDb());
    const bob = await makeUser(db, "bob@example.com");
    const theirs = await createWallet(bob.id, { name: "Bob", currency: "EUR", initialBalanceMinor: 0 });
    const state = await reconcileWalletAction(theirs.id, {}, fd({ actualBalance: "1", date: today() }));
    expect(state).toMatchObject({ message: "Wallet not found." });
    expect((await listTransactions(bob.id)).total).toBe(0);
  });
});

describe("parseReconcile", () => {
  it("reports both fields at once", () => {
    const values = { actualBalance: "abc", date: "2026-02-30" };
    const r = parseReconcile(fd(values), values, "EUR");
    expect(r).toEqual({
      ok: false,
      state: {
        message: "Please fix the highlighted fields.",
        fieldErrors: { actualBalance: "Enter a valid amount in EUR (up to 2 decimals).", date: "Enter a valid date." },
        values,
      },
    });
  });

  it("accepts a signed amount with either separator", () => {
    const values = { actualBalance: "−1.234,56", date: "2026-11-25" };
    expect(parseReconcile(fd(values), values, "EUR")).toEqual({
      ok: true,
      data: { actualBalanceMinor: -123_456, date: "2026-11-25" },
    });
  });
});
