// The create Server Actions behind the Add form: `mode=dialog` returns `{ ok: true }` (the dialog closes or clears
// itself), the full page still redirects to `returnTo`. Next's request APIs are mocked; the services run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransaction, getTransaction, listTransactions } from "@/server/transactions";
import { createTransfer, getTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { getDb } from "@/db";
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
    throw new RedirectSignal(url);
  },
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const { createTransactionAction, createTransferAction, updateTransactionInlineAction, updateTransferInlineAction } =
  await import("@/app/(app)/transactions/actions");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
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
let bank: number;
let yen: number;

beforeEach(async () => {
  const db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  session.userId = user.id;
  next.revalidated = [];
  cash = (await createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
  bank = (await createWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
  yen = (await createWallet(user.id, { name: "Tokyo", currency: "JPY", initialBalanceMinor: 0 })).id;
});

function expense(extra: Record<string, string> = {}) {
  return fd({
    kind: "expense",
    walletId: String(cash),
    categoryId: String(user.cat("Food")),
    amount: "12.40",
    date: "2026-11-07",
    note: "",
    returnTo: "/wallets",
    ...extra,
  });
}

describe("createTransactionAction", () => {
  it("with mode=dialog saves, revalidates every page and returns ok with a status line instead of redirecting", async () => {
    const state = await createTransactionAction({}, expense({ mode: "dialog" }));
    expect(state).toEqual({ ok: true, message: "Added €12.40 to Food" });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    const saved = (await listTransactions(user.id, {})).items;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "expense", walletId: cash, amountMinor: 1240, date: "2026-11-07" });
  });

  it("without mode still redirects to returnTo (the full page and no-JS use)", async () => {
    expect(await redirectOf(createTransactionAction({}, expense()))).toBe("/wallets");
    expect(await redirectOf(createTransactionAction({}, expense({ returnTo: "//evil.example" })))).toBe("/transactions");
    expect((await listTransactions(user.id, {})).items).toHaveLength(2);
  });

  it("returns field errors with the values echoed in dialog mode, saving nothing", async () => {
    const state = await createTransactionAction({}, expense({ mode: "dialog", amount: "" }));
    expect(state.ok).toBeUndefined();
    expect(state.fieldErrors?.amount).toBe("Enter an amount.");
    expect(state.values).toMatchObject({ walletId: String(cash), categoryId: String(user.cat("Food")), mode: "dialog" });
    expect(next.revalidated).toEqual([]);
    expect((await listTransactions(user.id, {})).items).toHaveLength(0);
  });

  it("takes the wallet and category the pills post, and the wallet's currency for the amount", async () => {
    const state = await createTransactionAction(
      {},
      expense({ mode: "dialog", kind: "income", walletId: String(yen), categoryId: String(user.cat("Salary")), amount: "1500" }),
    );
    expect(state).toEqual({ ok: true, message: "Added ¥1,500 to Salary" });
    expect((await listTransactions(user.id, {})).items[0]).toMatchObject({ kind: "income", walletId: yen, amountMinor: 1500 });

    const decimals = await createTransactionAction({}, expense({ mode: "dialog", walletId: String(yen), amount: "1.5" }));
    expect(decimals.fieldErrors?.amount).toMatch(/whole amount in JPY/);
  });
});

describe("createTransferAction", () => {
  function transfer(extra: Record<string, string> = {}) {
    return fd({
      kind: "transfer",
      fromWalletId: String(cash),
      toWalletId: String(bank),
      amount: "50",
      date: "2026-11-08",
      note: "",
      returnTo: "/transactions",
      ...extra,
    });
  }

  it("with mode=dialog returns ok and does not redirect", async () => {
    const state = await createTransferAction({}, transfer({ mode: "dialog" }));
    expect(state).toEqual({ ok: true, message: "Moved €50.00 from Cash to Bank" });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect((await listTransactions(user.id, {})).items).toHaveLength(2);
  });

  it("without mode redirects", async () => {
    expect(await redirectOf(createTransferAction({}, transfer()))).toBe("/transactions");
  });

  it("asks for the received amount across currencies", async () => {
    const missing = await createTransferAction({}, transfer({ mode: "dialog", toWalletId: String(yen) }));
    expect(missing.fieldErrors?.receivedAmount).toBe("Enter the amount received in JPY.");
    const ok = await createTransferAction({}, transfer({ mode: "dialog", toWalletId: String(yen), receivedAmount: "8000" }));
    expect(ok.ok).toBe(true);
  });
});

describe("updateTransactionInlineAction (the in-place row editor)", () => {
  let id: number;
  beforeEach(async () => {
    id = (await createTransaction(user.id, {
      kind: "expense",
      walletId: cash,
      categoryId: user.cat("Food"),
      amountMinor: 380,
      date: "2026-11-08",
      note: "Coffee",
    })).id;
  });

  it("saves, revalidates every page and returns ok with a message instead of redirecting", async () => {
    const state = await updateTransactionInlineAction(id, {}, expense({ amount: "4.80", note: "Coffee", date: "2026-11-08" }));
    expect(state).toEqual({ ok: true, message: "Saved €4.80 · Food" });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect(await getTransaction(user.id, id)).toMatchObject({ amountMinor: 480, note: "Coffee" });
  });

  it("returns field errors with the values echoed, saving nothing", async () => {
    const state = await updateTransactionInlineAction(id, {}, expense({ amount: "abc" }));
    expect(state.ok).toBeUndefined();
    expect(state.fieldErrors?.amount).toMatch(/valid amount in EUR/);
    expect(state.values).toMatchObject({ amount: "abc", walletId: String(cash) });
    expect(next.revalidated).toEqual([]);
    expect((await getTransaction(user.id, id))?.amountMinor).toBe(380);

    const wrongCategory = await updateTransactionInlineAction(id, {}, expense({ categoryId: String(user.cat("Salary")) }));
    expect(wrongCategory.fieldErrors?.categoryId).toBeTruthy();
  });

  it("treats another user's transaction as missing", async () => {
    const other = await makeUser(await getDb(), "bob@example.com");
    session.userId = other.id;
    const bobCash = (await createWallet(other.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
    const state = await updateTransactionInlineAction(
      id,
      {},
      expense({ walletId: String(bobCash), categoryId: String(other.cat("Food")) }),
    );
    expect(state.ok).toBeUndefined();
    expect(state.message).toBe("Transaction not found.");
    expect(next.revalidated).toEqual([]);
    expect((await getTransaction(user.id, id))?.amountMinor).toBe(380);
  });

  it("rejects a bound id that is not a positive integer", async () => {
    await expect(updateTransactionInlineAction(-1, {}, expense())).rejects.toThrow("Invalid id.");
  });
});

describe("updateTransferInlineAction", () => {
  let transferId: number;
  beforeEach(async () => {
    transferId = (await createTransfer(user.id, { fromWalletId: cash, toWalletId: bank, amountMinor: 5000, date: "2026-11-08" })).id;
  });

  function transfer(extra: Record<string, string> = {}) {
    return fd({
      fromWalletId: String(cash),
      toWalletId: String(bank),
      amount: "60",
      date: "2026-11-08",
      note: "",
      returnTo: "/transactions",
      ...extra,
    });
  }

  it("rewrites the transfer and returns ok without redirecting", async () => {
    const state = await updateTransferInlineAction(transferId, {}, transfer());
    expect(state).toEqual({ ok: true, message: "Saved €60.00 from Cash to Bank" });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect(await getTransfer(user.id, transferId)).toMatchObject({ from: { amountMinor: 6000 }, to: { amountMinor: 6000 } });
  });

  it("echoes errors (same wallet twice, missing received amount across currencies)", async () => {
    const same = await updateTransferInlineAction(transferId, {}, transfer({ toWalletId: String(cash) }));
    expect(same.fieldErrors?.toWalletId).toBe("Choose two different wallets.");
    expect(same.values).toMatchObject({ amount: "60" });
    const cross = await updateTransferInlineAction(transferId, {}, transfer({ toWalletId: String(yen) }));
    expect(cross.fieldErrors?.receivedAmount).toBe("Enter the amount received in JPY.");
    expect(next.revalidated).toEqual([]);
    expect((await getTransfer(user.id, transferId))?.from.amountMinor).toBe(5000);
  });
});
