"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, type FormState } from "@/lib/form";
import { usageText } from "@/lib/usage-text";
import {
  archiveCategory,
  changeCategoryKind,
  createCategory,
  deleteCategory,
  getCategory,
  renameCategory,
  unarchiveCategory,
} from "@/server/categories";
import { nameField, parseCategoryId, parseCategoryKind, parseReplacement } from "./form-input";

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
  let name: string;
  try {
    name = (await renameCategory(user.id, categoryId, { name: nameField(formData) })).name;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  return { ok: true, message: `Renamed to “${name}”.` };
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
  let name: string;
  try {
    name = (await changeCategoryKind(user.id, categoryId, { kind })).name;
  } catch (err) {
    // It gained transactions since the page was rendered: refresh the counts so the row explains why.
    if (isServiceError(err) && err.code === "CONFLICT") revalidateCategories();
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  return { ok: true, message: `“${name}” is now an ${kind} category.` };
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
