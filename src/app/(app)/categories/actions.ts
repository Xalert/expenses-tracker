"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, type FormState } from "@/lib/form";
import { createCategory, deleteCategory, getCategory, renameCategory } from "@/server/categories";
import { nameField, parseCategoryId, parseCategoryKind, parseMoveTo } from "./form-input";

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
    name = createCategory(user.id, { name: nameField(formData), kind }).name;
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
    name = renameCategory(user.id, categoryId, { name: nameField(formData) }).name;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateCategories();
  return { ok: true, message: `Renamed to “${name}”.` };
}

/**
 * Bind the category id. Optional `moveToCategoryId` field: the replacement for a category that has transactions.
 * Stays on /categories.
 */
export async function deleteCategoryAction(
  categoryIdArg: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const categoryId = parseCategoryId(categoryIdArg);
  const category = categoryId ? getCategory(user.id, categoryId) : null;
  if (!category) {
    revalidateCategories();
    return NOT_FOUND_STATE;
  }
  const moveToCategoryId = parseMoveTo(formData);
  let moved: number;
  try {
    moved = deleteCategory(user.id, category.id, { moveToCategoryId }).movedTransactions;
  } catch (err) {
    // The category gained transactions since the page was rendered: refresh the counts so the row offers the
    // replacement picker.
    if (isServiceError(err) && err.code === "CONFLICT") revalidateCategories();
    return serviceErrorState(err, values);
  }
  const target = moved > 0 && moveToCategoryId ? getCategory(user.id, moveToCategoryId) : null;
  revalidateCategories();
  return {
    ok: true,
    message: target
      ? `Removed “${category.name}” and moved ${moved === 1 ? "1 transaction" : `${moved} transactions`} to “${target.name}”.`
      : `Removed “${category.name}”.`,
  };
}
