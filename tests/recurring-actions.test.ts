// The /recurring Server Actions: plain pause / resume / delete forms and the edit form. Next's request APIs are
// mocked; the services run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { addDays, todayISO } from "@/lib/dates";
import { createRecurringEntry, getRecurring, type RecurringView } from "@/server/recurring";
import { listTransactions } from "@/server/transactions";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const session = vi.hoisted(() => ({ userId: 0 }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.userId, timeZone: null }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
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

const { deleteRecurringAction, pauseRecurringAction, resumeRecurringAction, updateRecurringAction } = await import(
  "@/app/(app)/recurring/actions"
);

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

const today = todayISO();
let user: Awaited<ReturnType<typeof makeUser>>;
let bank: number;
let yen: number;
let rule: RecurringView;

beforeEach(async () => {
  const db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  session.userId = user.id;
  bank = (await createWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
  yen = (await createWallet(user.id, { name: "Tokyo", currency: "JPY", initialBalanceMinor: 0 })).id;
  rule = (
    await createRecurringEntry(
      user.id,
      { kind: "expense", walletId: bank, categoryId: user.cat("Housing"), amountMinor: 95_000, date: today, note: "rent" },
      { frequency: "monthly" },
      today,
    )
  ).rule;
});

describe("pause, resume, delete", () => {
  it("pause and resume go back to the rule on the list", async () => {
    expect(await redirectOf(pauseRecurringAction(fd({ id: String(rule.id) })))).toBe(`/recurring#rule-${rule.id}`);
    expect((await getRecurring(user.id, rule.id))!.status).toBe("paused");
    expect(await redirectOf(resumeRecurringAction(fd({ id: String(rule.id) })))).toBe(`/recurring#rule-${rule.id}`);
    expect((await getRecurring(user.id, rule.id))!.status).toBe("active");
  });

  it("a resume refused while the wallet is archived just reloads", async () => {
    await redirectOf(pauseRecurringAction(fd({ id: String(rule.id) })));
    await archiveWallet(user.id, bank);
    expect(await redirectOf(resumeRecurringAction(fd({ id: String(rule.id) })))).toBe(`/recurring#rule-${rule.id}`);
    expect((await getRecurring(user.id, rule.id))!.status).toBe("paused");
  });

  it("delete keeps the entries; a bad or missing id just goes back", async () => {
    expect(await redirectOf(deleteRecurringAction(fd({ id: String(rule.id), returnTo: "/elsewhere" })))).toBe("/recurring");
    expect(await getRecurring(user.id, rule.id)).toBeNull();
    expect((await listTransactions(user.id)).total).toBe(1);
    expect(await redirectOf(deleteRecurringAction(fd({ id: String(rule.id) })))).toBe("/recurring");
    expect(await redirectOf(pauseRecurringAction(fd({ id: "abc" })))).toBe("/recurring");
  });

  it("another user's rule is not touched", async () => {
    const bob = await makeUser(await getDb(), "bob@example.com");
    session.userId = bob.id;
    await redirectOf(pauseRecurringAction(fd({ id: String(rule.id) })));
    await redirectOf(deleteRecurringAction(fd({ id: String(rule.id) })));
    expect((await getRecurring(user.id, rule.id))!.status).toBe("active");
  });
});

describe("updateRecurringAction", () => {
  const form = (extra: Record<string, string> = {}) =>
    fd({
      walletId: String(bank),
      categoryId: String(user.cat("Housing")),
      amount: "990",
      note: "new rent",
      frequency: "monthly",
      interval: "1",
      nextDate: rule.nextDate!,
      endDate: "",
      ...extra,
    });

  it("saves and goes back to the rule", async () => {
    expect(await redirectOf(updateRecurringAction(rule.id, {}, form()))).toBe(`/recurring#rule-${rule.id}`);
    expect(await getRecurring(user.id, rule.id)).toMatchObject({ amountMinor: 99_000, note: "new rent", endDate: null });
  });

  it("parses the amount in the chosen wallet's currency", async () => {
    const state = await updateRecurringAction(rule.id, {}, form({ walletId: String(yen), amount: "1.5" }));
    expect(state.fieldErrors?.amount).toBe("Enter a whole amount in JPY (no decimals).");
    await redirectOf(updateRecurringAction(rule.id, {}, form({ walletId: String(yen), amount: "15000" })));
    expect(await getRecurring(user.id, rule.id)).toMatchObject({ walletId: yen, amountMinor: 15_000, currency: "JPY" });
  });

  it("puts errors on their fields with the values echoed", async () => {
    const state = await updateRecurringAction(
      rule.id,
      {},
      form({ amount: "", frequency: "hourly", interval: "0", nextDate: "soon", endDate: "never", categoryId: "x" }),
    );
    expect(state.fieldErrors).toMatchObject({
      amount: "Enter an amount.",
      frequency: "Choose how often it repeats.",
      interval: "Enter a whole number from 1 to 99.",
      nextDate: "Enter the date of the next entry.",
      endDate: "Enter a valid end date.",
      categoryId: "Choose a category.",
    });
    expect(state.values).toMatchObject({ frequency: "hourly", note: "new rent" });
  });

  it("maps the service's errors (a past next date, the wrong kind)", async () => {
    const past = await updateRecurringAction(rule.id, {}, form({ frequency: "weekly", nextDate: addDays(today, -1) }));
    expect(past.fieldErrors?.nextDate).toMatch(/today or a later date/);
    const kind = await updateRecurringAction(rule.id, {}, form({ categoryId: String(user.cat("Salary")) }));
    expect(kind.fieldErrors?.categoryId).toBe("Choose an expense category.");
  });

  it("a rule of another user is not found", async () => {
    const bob = await makeUser(await getDb(), "bob@example.com");
    session.userId = bob.id;
    const state = await updateRecurringAction(rule.id, {}, form({ walletId: String(bank) }));
    expect(state.fieldErrors?.walletId ?? state.message).toMatch(/not found/i);
    session.userId = user.id;
    expect((await getRecurring(user.id, rule.id))!.amountMinor).toBe(95_000);
  });
});
