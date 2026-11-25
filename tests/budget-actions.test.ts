// The /categories Server Actions for budgets and colours: parse the form, call the services, map errors onto the
// fields and echo the values, revalidate every page. Next's request APIs are mocked; the services run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listBudgets, setBudget } from "@/server/budgets";
import { getCategory, listCategories } from "@/server/categories";
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

const { changeCategoryKindAction, createCategoryAction, removeBudgetAction, renameCategoryAction, setBudgetAction } =
  await import("@/app/(app)/categories/actions");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

let user: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  const db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  other = await makeUser(db, "bob@example.com");
  session.userId = user.id;
  next.revalidated = [];
  await createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
  await createWallet(user.id, { name: "Tokyo", currency: "JPY", initialBalanceMinor: 0 });
});

describe("setBudgetAction", () => {
  it("sets a category budget from the typed amount in the chosen currency, then replaces it", async () => {
    const food = user.cat("Food");
    expect(await setBudgetAction(food, {}, fd({ amount: "1.234,50", currency: "EUR" }))).toEqual({
      ok: true,
      message: "Budget for “Food”: €1,234.50 a month.",
    });
    expect(next.revalidated).toContainEqual(["/", "layout"]);
    expect(await setBudgetAction(food, {}, fd({ amount: "30000", currency: "JPY" }))).toMatchObject({ ok: true });
    expect(await listBudgets(user.id)).toEqual([expect.objectContaining({ categoryId: food, currency: "JPY", amountMinor: 30000 })]);
  });

  it("sets the overall budget (bound null)", async () => {
    expect(await setBudgetAction(null, {}, fd({ amount: "2000", currency: "EUR" }))).toEqual({
      ok: true,
      message: "Overall budget: €2,000.00 a month.",
    });
    expect(await listBudgets(user.id)).toEqual([expect.objectContaining({ categoryId: null, amountMinor: 200000 })]);
  });

  it("puts errors on the amount and currency fields and echoes the values", async () => {
    const food = user.cat("Food");
    expect(await setBudgetAction(food, {}, fd({ amount: "", currency: "EUR" }))).toEqual({
      fieldErrors: { amount: "Enter an amount." },
      values: { amount: "", currency: "EUR" },
    });
    expect(await setBudgetAction(food, {}, fd({ amount: "12.5", currency: "JPY" }))).toMatchObject({
      fieldErrors: { amount: "Enter a whole amount in JPY (no decimals)." },
      values: { amount: "12.5", currency: "JPY" },
    });
    expect(await setBudgetAction(food, {}, fd({ amount: "1.234", currency: "EUR" }))).toMatchObject({
      fieldErrors: { amount: "Enter a valid amount in EUR (up to 2 decimals)." },
    });
    expect(await setBudgetAction(food, {}, fd({ amount: "0", currency: "EUR" }))).toMatchObject({
      fieldErrors: { amount: "Enter an amount greater than zero." },
    });
    expect(await setBudgetAction(food, {}, fd({ amount: "10", currency: "nope" }))).toMatchObject({
      fieldErrors: { currency: "Choose a currency." },
    });
    // A valid code the user holds no wallet in: the service's message, on the field.
    expect(await setBudgetAction(food, {}, fd({ amount: "10", currency: "USD" }))).toMatchObject({
      fieldErrors: { currency: "Choose the currency of one of your wallets (EUR, JPY)." },
      values: { amount: "10", currency: "USD" },
    });
    expect(await setBudgetAction(user.cat("Salary"), {}, fd({ amount: "10", currency: "EUR" }))).toMatchObject({
      fieldErrors: { categoryId: "Budgets are for expense categories only." },
    });
    expect(await listBudgets(user.id)).toEqual([]);
  });

  it("answers not found for another user's category or a bad bound id", async () => {
    expect(await setBudgetAction(other.cat("Food"), {}, fd({ amount: "10", currency: "EUR" }))).toMatchObject({
      message: "Category not found. It may have been removed already.",
    });
    expect(await setBudgetAction("1; drop" as unknown as number, {}, fd({ amount: "10", currency: "EUR" }))).toMatchObject({
      message: "Category not found. It may have been removed already.",
    });
    expect(await listBudgets(other.id)).toEqual([]);
  });
});

describe("removeBudgetAction", () => {
  it("removes a category's budget or the overall one; another user's stays", async () => {
    await setBudget(user.id, { categoryId: user.cat("Food"), currency: "EUR", amountMinor: 100 });
    await setBudget(user.id, { categoryId: null, currency: "EUR", amountMinor: 100 });
    await createWallet(other.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await setBudget(other.id, { categoryId: other.cat("Food"), currency: "EUR", amountMinor: 100 });
    expect(await removeBudgetAction(user.cat("Food"))).toEqual({ ok: true, message: "Removed the budget for “Food”." });
    expect(await removeBudgetAction(null)).toEqual({ ok: true, message: "Removed the overall budget." });
    expect(await listBudgets(user.id)).toEqual([]);
    await removeBudgetAction(other.cat("Food"));
    expect(await listBudgets(other.id)).toHaveLength(1);
  });
});

describe("renameCategoryAction with a colour", () => {
  it("saves the colour (Saved …), clears it with an empty value, keeps it when the field is absent", async () => {
    const food = user.cat("Food");
    expect(await renameCategoryAction(food, {}, fd({ name: "Food", color: "teal" }))).toEqual({ ok: true, message: "Saved “Food”." });
    expect((await getCategory(user.id, food))?.color).toBe("teal");
    expect(await renameCategoryAction(food, {}, fd({ name: "Meals" }))).toEqual({ ok: true, message: "Renamed to “Meals”." });
    expect((await getCategory(user.id, food))?.color).toBe("teal");
    await renameCategoryAction(food, {}, fd({ name: "Meals", color: "" }));
    expect((await getCategory(user.id, food))?.color).toBeNull();
  });

  it("refuses a colour outside the palette on the colour field, echoing the values", async () => {
    expect(await renameCategoryAction(user.cat("Food"), {}, fd({ name: "Food", color: "pink" }))).toEqual({
      fieldErrors: { color: "Choose a colour from the list." },
      values: { name: "Food", color: "pink" },
    });
    expect(await renameCategoryAction(other.cat("Food"), {}, fd({ name: "Mine", color: "red" }))).toMatchObject({
      message: "Category not found. It may have been removed already.",
    });
    expect((await getCategory(other.id, other.cat("Food")))?.name).toBe("Food");
  });
});

describe("changeCategoryKindAction and budgets", () => {
  it("says the budget was removed with the change", async () => {
    await createCategoryAction("expense", {}, fd({ name: "Gifts" }));
    const id = (await listCategories(user.id)).find((c) => c.name === "Gifts")!.id;
    await setBudget(user.id, { categoryId: id, currency: "EUR", amountMinor: 100 });
    expect(await changeCategoryKindAction(id, {}, fd({ kind: "income" }))).toEqual({
      ok: true,
      message: "“Gifts” is now an income category. Its budget was removed.",
    });
    expect(await changeCategoryKindAction(id, {}, fd({ kind: "expense" }))).toEqual({
      ok: true,
      message: "“Gifts” is now an expense category.",
    });
  });
});
