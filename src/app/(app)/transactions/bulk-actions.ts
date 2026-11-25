"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { amountRangeErrors, listFilters, listHref, parseListParams } from "@/components/transactions/list-params";
import { requireUser } from "@/lib/auth";
import { encodeOutcome, type BulkOutcome } from "@/lib/bulk-result";
import { todayInZone } from "@/lib/dates";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, type FormState } from "@/lib/form";
import { getGroupScope } from "@/lib/group-scope";
import {
  bulkAddTag,
  bulkDelete,
  bulkRemoveTag,
  bulkSetCategory,
  previewBulk,
  type BulkSelection,
  type BulkTarget,
} from "@/server/bulk";

/**
 * The bulk bar's state. `confirm`: a Delete waiting for confirmation, with the counts the server found (the confirm
 * button posts them back as `confirmed`, and the delete is refused if the target no longer matches them).
 * `selectedIds`: the ticked rows, echoed so a page rendered from this state (no JavaScript) ticks them again.
 */
export type BulkState = FormState & {
  confirm?: BulkSelection & { all: boolean };
  selectedIds?: number[];
};

const OPS = ["delete", "category", "addTag", "removeTag"] as const;
type Op = (typeof OPS)[number];

function positiveId(value: FormDataEntryValue | null): number | null {
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
}

/** `"<entries>:<transfers>"` → the counts a confirm button carries. */
function parseConfirmed(value: FormDataEntryValue | null): BulkSelection | null {
  const m = typeof value === "string" ? /^(\d{1,9}):(\d{1,9})$/.exec(value) : null;
  return m ? { entries: Number(m[1]), transfers: Number(m[2]) } : null;
}

/** The list's query string as the page parses it (repeated keys kept). */
function listSearchParams(list: string): Record<string, string[]> {
  const sp = new URLSearchParams(list.startsWith("?") ? list.slice(1) : list);
  return Object.fromEntries([...new Set(sp.keys())].map((k) => [k, sp.getAll(k)]));
}

/**
 * The /transactions bulk bar (`useActionState`). Fields: `op` (delete / category / addTag / removeTag), `ids` (one
 * per ticked row; a transfer leg stands for its transfer), `scope=all` (every entry matching the list's filters
 * instead — `list` carries the list's query string, re-evaluated here with the user's today and wallet-group scope),
 * `categoryId`, `tagName`, `tagId`, `confirmed` (a Delete's confirmed counts) and `intent=cancel` (drop the pending
 * confirmation). Delete always asks first: without `confirmed` it returns `confirm` with the counts. On success it
 * revalidates every page and redirects to the list without selection mode, the outcome in `?done=` (the result line).
 */
export async function bulkEditAction(_prev: BulkState, formData: FormData): Promise<BulkState> {
  const user = await requireUser();
  const values = formValues(formData, ["ids", "confirmed", "intent", "list"]);
  const all = formData.get("scope") === "all";
  const selectedIds = [...new Set(formData.getAll("ids").map(positiveId))].filter((n): n is number => n !== null);
  const echo = { values, selectedIds };

  if (formData.get("intent") === "cancel") return echo;

  const op = formData.get("op");
  if (typeof op !== "string" || !OPS.includes(op as Op)) {
    return { ...echo, fieldErrors: { op: "Choose what to do with the selection." } };
  }

  const list = typeof formData.get("list") === "string" ? String(formData.get("list")) : "";
  const params = parseListParams(listSearchParams(list));
  let target: BulkTarget;
  if (all) {
    const problem = amountRangeErrors(params);
    if (problem.min || problem.max) {
      return { ...echo, message: `Fix the amount filter first: ${problem.min ?? problem.max}` };
    }
    const { selected } = await getGroupScope();
    const thisMonth = todayInZone(user.timeZone).slice(0, 7);
    target = { filters: { ...listFilters(params, thisMonth), groupId: selected?.id } };
  } else {
    if (selectedIds.length === 0) return { ...echo, message: "Tick at least one entry first, or choose all matching." };
    target = { ids: selectedIds };
  }

  let outcome: BulkOutcome;
  try {
    switch (op as Op) {
      case "delete": {
        const confirmed = parseConfirmed(formData.get("confirmed"));
        if (!confirmed) return { ...echo, confirm: { ...(await previewBulk(user.id, target)), all } };
        let done: BulkSelection;
        try {
          done = await bulkDelete(user.id, target, { expected: confirmed });
        } catch (err) {
          if (!isServiceError(err) || err.code !== "CONFLICT") throw err;
          // Changed since the confirmation: ask again with the new counts.
          return { ...echo, message: err.message, confirm: { ...(await previewBulk(user.id, target)), all } };
        }
        outcome = { op: "delete", ...done };
        break;
      }
      case "category": {
        const categoryId = positiveId(formData.get("categoryId"));
        if (categoryId === null) return { ...echo, fieldErrors: { categoryId: "Choose a category." } };
        const r = await bulkSetCategory(user.id, target, categoryId);
        outcome = {
          op: "category",
          categoryId: r.category.id,
          changed: r.changed,
          unchanged: r.unchanged,
          otherKind: r.skippedOtherKind,
          transfers: r.skippedTransfers,
        };
        break;
      }
      case "addTag": {
        const tagName = formData.get("tagName");
        if (typeof tagName === "string" && tagName.length > 200) {
          return { ...echo, fieldErrors: { tagName: "That is too much text for a tag." } };
        }
        const r = await bulkAddTag(user.id, target, typeof tagName === "string" ? tagName : "");
        outcome = {
          op: "addTag",
          tagId: r.tag.id ?? 0,
          added: r.added,
          already: r.already,
          atLimit: r.skippedAtLimit,
          transfers: r.skippedTransfers,
        };
        break;
      }
      case "removeTag": {
        const tagId = positiveId(formData.get("tagId"));
        if (tagId === null) return { ...echo, fieldErrors: { tagId: "Choose a tag." } };
        const r = await bulkRemoveTag(user.id, target, tagId);
        outcome = { op: "removeTag", tagId: r.tag.id, removed: r.removed, notTagged: r.notTagged, transfers: r.skippedTransfers };
        break;
      }
    }
  } catch (err) {
    return { ...serviceErrorState(err, values), selectedIds };
  }

  // Balances, lists, charts and the tag counts on every page may have changed.
  revalidatePath("/", "layout");
  const href = listHref(params, { select: undefined, page: 1 });
  redirect(`${href}${href.includes("?") ? "&" : "?"}done=${encodeOutcome(outcome)}`);
}
