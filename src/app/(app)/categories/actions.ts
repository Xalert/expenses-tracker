"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { isValidCurrency } from "@/lib/currencies";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, type FormState } from "@/lib/form";
import { usageText } from "@/lib/usage-text";
import { currencyDecimals, formatMoney, parseAmount } from "@/lib/money";
import { removeBudget, setBudget } from "@/server/budgets";
import {
  archiveCategory,
  changeCategoryKind,
  createCategory,
  deleteCategory,
  getCategory,
  renameCategory,
  unarchiveCategory,
} from "@/server/categories";
import { deleteTag, getTag, renameTag } from "@/server/tags";
import { colorField, nameField, parseBudgetTarget, parseCategoryId, parseCategoryKind, parseReplacement } from "./form-input";

const NOT_FOUND_STATE: FormState = { message: "Category not found. It may have been removed already." };


/** Category names show up on every signed-in page (dashboard, lists, filters, wallet pages, forms). */
function revalidateCategories() {
  revalidatePath("/", "layout");
}

/** Bind the section's kind: `createCategoryAction.bind(null, "expense")`. Stays on /categories. */
export async function createCategoryAction(kindArg: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const kind = parseCategoryKind(kindArg);
  if (!kind) return { message: "Choose expense or income.", values };
  let name: string;
  try {
    name = (await createCategory(user.id, { name: nameField(formData), kind })).name;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  return { ok: true, message: `Added “${name}”.` };
}

// ---------------------------------------------------------------------------------------------
// Tags (the "Tags" card on /categories)

const TAG_NOT_FOUND_STATE: FormState = { message: "Tag not found. It may have been removed already." };

/** `merged`: the tag was renamed onto another tag's name and merged into it (so its row is gone). */
export type TagRenameState = FormState & { merged?: boolean };

/** Bind the tag id. Field `name`. Renaming onto another tag's name merges the two. Stays on /categories. */
export async function renameTagAction(tagIdArg: number, _prev: TagRenameState, formData: FormData): Promise<TagRenameState> {
  const user = await requireUser();
  const values = formValues(formData);
  const tagId = parseCategoryId(tagIdArg);
  if (!tagId) return { ...TAG_NOT_FOUND_STATE, values };
  const before = await getTag(user.id, tagId);
  if (!before) {
    revalidateCategories();
    return { ...TAG_NOT_FOUND_STATE, values };
  }
  let result: Awaited<ReturnType<typeof renameTag>>;
  try {
    result = await renameTag(user.id, tagId, { name: formData.get("name") });
  } catch (err) {
    if (isServiceError(err) && err.code === "NOT_FOUND") revalidateCategories();
    return serviceErrorState(err, values);
  }
  // Tag names show on entry rows and in the filters of every list.
  revalidateCategories();
  const { tag, mergedFrom } = result;
  if (mergedFrom !== null) return { ok: true, merged: true, message: `Merged “${mergedFrom}” into “${tag.name}”.` };
  return { ok: true, message: tag.name === before.name ? `Saved “${tag.name}”.` : `Renamed to “${tag.name}”.` };
}

/** Bind the tag id; no form fields. Removes the tag from its entries (they stay). Stays on /categories. */
export async function deleteTagAction(tagIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const tagId = parseCategoryId(tagIdArg);
  if (!tagId) return TAG_NOT_FOUND_STATE;
  let removed: Awaited<ReturnType<typeof deleteTag>>;
  try {
    removed = await deleteTag(user.id, tagId);
  } catch (err) {
    if (isServiceError(err) && err.code === "NOT_FOUND") revalidateCategories();
    return serviceErrorState(err);
  }
  revalidateCategories();
  const n = removed.transactionCount;
  return {
    ok: true,
    message: n === 0 ? `Deleted “${removed.name}”.` : `Deleted “${removed.name}” and took it off ${n === 1 ? "1 entry" : `${n} entries`}.`,
  };
}

/** Bind the category id. Stays on /categories. */
export async function renameCategoryAction(
  categoryIdArg: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const categoryId = parseCategoryId(categoryIdArg);
  if (!categoryId) return { ...NOT_FOUND_STATE, values };
  const before = await getCategory(user.id, categoryId);
  if (!before) {
    revalidateCategories();
    return { ...NOT_FOUND_STATE, values };
  }
  let name: string;
  try {
    name = (await renameCategory(user.id, categoryId, { name: nameField(formData), color: colorField(formData) })).name;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  return { ok: true, message: name === before.name ? `Saved “${name}”.` : `Renamed to “${name}”.` };
}

/** The error for a typed amount that is not one in `currency` (whole for JPY, up to its decimals otherwise). */
function amountError(currency: string): string {
  const decimals = currencyDecimals(currency);
  return decimals === 0
    ? `Enter a whole amount in ${currency} (no decimals).`
    : `Enter a valid amount in ${currency} (up to ${decimals} decimals).`;
}

/**
 * Bind the target: a category id, or null for the overall budget. Fields `amount` (typed, parsed with `parseAmount` in
 * the chosen currency) and `currency`. Creates or replaces the budget. Stays on /categories.
 */
export async function setBudgetAction(targetArg: number | null, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const target = parseBudgetTarget(targetArg);
  if (target === undefined) return { ...NOT_FOUND_STATE, values };
  const currencyRaw = formData.get("currency");
  const currency = typeof currencyRaw === "string" ? currencyRaw.trim().toUpperCase() : "";
  if (!isValidCurrency(currency)) return { fieldErrors: { currency: "Choose a currency." }, values };
  const rawAmount = formData.get("amount");
  const amount = typeof rawAmount === "string" ? rawAmount.trim() : "";
  if (!amount) return { fieldErrors: { amount: "Enter an amount." }, values };
  const amountMinor = parseAmount(amount, currency);
  if (amountMinor === null) return { fieldErrors: { amount: amountError(currency) }, values };
  if (amountMinor <= 0) return { fieldErrors: { amount: "Enter an amount greater than zero." }, values };
  const category = target === null ? null : await getCategory(user.id, target);
  if (target !== null && !category) {
    revalidateCategories();
    return { ...NOT_FOUND_STATE, values };
  }
  let saved: Awaited<ReturnType<typeof setBudget>>;
  try {
    saved = await setBudget(user.id, { categoryId: target, currency, amountMinor });
  } catch (err) {
    if (isServiceError(err) && err.code === "NOT_FOUND") revalidateCategories();
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  const limit = `${formatMoney(saved.amountMinor, saved.currency)} a month`;
  return { ok: true, message: category ? `Budget for “${category.name}”: ${limit}.` : `Overall budget: ${limit}.` };
}

/** Bind the target (a category id, or null for the overall budget); no form fields. Stays on /categories. */
export async function removeBudgetAction(targetArg: number | null): Promise<FormState> {
  const user = await requireUser();
  const target = parseBudgetTarget(targetArg);
  if (target === undefined) return NOT_FOUND_STATE;
  const category = target === null ? null : await getCategory(user.id, target);
  await removeBudget(user.id, target);
  revalidateCategories();
  return {
    ok: true,
    message: target === null ? "Removed the overall budget." : `Removed the budget for “${category?.name ?? "the category"}”.`,
  };
}

/** Bind the category id. Field `kind`: the kind to switch to (refused while the category has transactions). */
export async function changeCategoryKindAction(
  categoryIdArg: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const categoryId = parseCategoryId(categoryIdArg);
  if (!categoryId) return { ...NOT_FOUND_STATE, values };
  const kind = parseCategoryKind(formData.get("kind"));
  if (!kind) return { fieldErrors: { kind: "Choose expense or income." }, values };
  let changed: Awaited<ReturnType<typeof changeCategoryKind>>;
  try {
    changed = await changeCategoryKind(user.id, categoryId, { kind });
  } catch (err) {
    // It gained transactions since the page was rendered: refresh the counts so the row explains why.
    if (isServiceError(err) && err.code === "CONFLICT") revalidateCategories();
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  return {
    ok: true,
    message: `“${changed.name}” is now an ${kind} category.${changed.budgetRemoved ? " Its budget was removed." : ""}`,
  };
}

/** Archive (`archived` true) or unarchive a category; no form fields. Stays on /categories. */
export async function setCategoryArchivedAction(categoryIdArg: number, archived: boolean): Promise<FormState> {
  const user = await requireUser();
  const categoryId = parseCategoryId(categoryIdArg);
  if (!categoryId) return NOT_FOUND_STATE;
  let name: string;
  try {
    name = (await (archived ? archiveCategory : unarchiveCategory)(user.id, categoryId)).name;
  } catch (err) {
    if (isServiceError(err) && err.code === "NOT_FOUND") revalidateCategories();
    return serviceErrorState(err);
  }
  revalidateCategories();
  return { ok: true, message: archived ? `Archived “${name}”.` : `Unarchived “${name}”.` };
}

/**
 * Bind the category id. The replacement for a category that has transactions: field `moveToCategoryId` (an existing
 * category), or `moveToNewCategoryName` when the select says "new" or there is no select. Stays on /categories.
 */
export async function deleteCategoryAction(
  categoryIdArg: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const categoryId = parseCategoryId(categoryIdArg);
  const category = categoryId ? await getCategory(user.id, categoryId) : null;
  if (!category) {
    revalidateCategories();
    return NOT_FOUND_STATE;
  }
  const replacement = parseReplacement(formData);
  let result: Awaited<ReturnType<typeof deleteCategory>>;
  try {
    result = await deleteCategory(user.id, category.id, replacement);
  } catch (err) {
    // The category gained transactions since the page was rendered: refresh the counts so the row offers the
    // replacement picker.
    if (isServiceError(err) && err.code === "CONFLICT") revalidateCategories();
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  const { movedTransactions: moved, movedRecurring, movedTo } = result;
  if ((moved === 0 && movedRecurring === 0) || !movedTo) return { ok: true, message: `Removed “${category.name}”.` };
  const what = usageText(moved, movedRecurring);
  return {
    ok: true,
    message: replacement.moveToNewCategoryName !== undefined
      ? `Removed “${category.name}” and moved ${what} to the new category “${movedTo.name}”.`
      : `Removed “${category.name}” and moved ${what} to “${movedTo.name}”.`,
  };
}
