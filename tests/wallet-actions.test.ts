// The wallet Server Actions behind the New / Edit wallet dialogs: `mode=dialog` returns `{ ok: true, message }` (the
// dialog closes itself), the full pages still redirect to the wallet. Next's request APIs are mocked; the services run
// for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWallet, getWallet, listWallets } from "@/server/wallets";
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

const { createWalletAction, updateWalletAction } = await import("@/app/(app)/wallets/actions");

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

let user: ReturnType<typeof makeUser>;

beforeEach(() => {
  const db = useFreshDb();
  user = makeUser(db, "alice@example.com");
  session.userId = user.id;
  next.revalidated = [];
});

describe("createWalletAction", () => {
  it("with mode=dialog creates the wallet, revalidates every page and returns ok instead of redirecting", async () => {
    const state = await createWalletAction(
      {},
      fd([["mode", "dialog"], ["name", "Probe"], ["currency", "chf"], ["initialBalance", "12.50"]]),
    );
    expect(state).toEqual({ ok: true, message: "Created Probe (CHF)" });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect(listWallets(user.id)).toEqual([
      expect.objectContaining({ name: "Probe", currency: "CHF", initialBalanceMinor: 1250 }),
    ]);
  });

  it("takes the typed code over the pill when both are posted, and the pill when the code is empty", async () => {
    // The form posts the pill first, then the text input (both named `currency`).
    await createWalletAction({}, fd([["mode", "dialog"], ["name", "A"], ["currency", "EUR"], ["currency", "chf"]]));
    await createWalletAction({}, fd([["mode", "dialog"], ["name", "B"], ["currency", "USD"], ["currency", "  "]]));
    expect(listWallets(user.id).map((w) => [w.name, w.currency])).toEqual([
      ["A", "CHF"],
      ["B", "USD"],
    ]);
  });

  it("without mode redirects to the new wallet (the full page and no-JS use)", async () => {
    const url = await redirectOf(createWalletAction({}, fd([["name", "Cash"], ["currency", "EUR"]])));
    const id = listWallets(user.id)[0].id;
    expect(url).toBe(`/wallets/${id}`);
    expect(next.revalidated).toContainEqual([`/wallets/${id}`]);
  });

  it("returns field errors with the chosen currency echoed, saving nothing", async () => {
    const state = await createWalletAction(
      {},
      fd([["mode", "dialog"], ["name", ""], ["currency", "EUR"], ["currency", "xyz"], ["initialBalance", "1"]]),
    );
    expect(state.ok).toBeUndefined();
    expect(state.fieldErrors).toMatchObject({ name: "Enter a name.", currency: "Choose a currency." });
    expect(state.values).toMatchObject({ currency: "XYZ", mode: "dialog", initialBalance: "1" });
    expect(next.revalidated).toEqual([]);
    expect(listWallets(user.id)).toHaveLength(0);

    const jpy = await createWalletAction({}, fd([["mode", "dialog"], ["name", "Tokyo"], ["currency", "JPY"], ["initialBalance", "1.5"]]));
    expect(jpy.fieldErrors?.initialBalance).toMatch(/whole amount in JPY/);
  });
});

describe("updateWalletAction", () => {
  let id: number;
  beforeEach(() => {
    id = createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 }).id;
  });

  it("with mode=dialog saves and returns ok without redirecting", async () => {
    const state = await updateWalletAction(id, {}, fd([["mode", "dialog"], ["name", "Pocket"], ["initialBalance", "-3"]]));
    expect(state).toEqual({ ok: true, message: "Saved Pocket" });
    expect(next.revalidated).toEqual([["/", "layout"]]);
    expect(getWallet(user.id, id)).toMatchObject({ name: "Pocket", initialBalanceMinor: -300, currency: "EUR" });
  });

  it("without mode redirects to the wallet", async () => {
    expect(await redirectOf(updateWalletAction(id, {}, fd([["name", "Pocket"], ["initialBalance", ""]])))).toBe(`/wallets/${id}`);
  });

  it("echoes errors and treats another user's wallet as missing", async () => {
    const bad = await updateWalletAction(id, {}, fd([["mode", "dialog"], ["name", " "], ["initialBalance", "x"]]));
    expect(Object.keys(bad.fieldErrors ?? {}).sort()).toEqual(["initialBalance", "name"]);
    expect(getWallet(user.id, id)?.name).toBe("Cash");

    const other = makeUser(getDb(), "bob@example.com");
    session.userId = other.id;
    const state = await updateWalletAction(id, {}, fd([["mode", "dialog"], ["name", "Mine"]]));
    expect(state.message).toBe("Wallet not found.");
    expect(next.revalidated).toEqual([]);
  });
});
