import type { NextRequest } from "next/server";
import { amountRangeErrors, parseListParams } from "@/components/transactions/list-params";
import { getCurrentUser } from "@/lib/auth";
import { todayInZone } from "@/lib/dates";
import { buildTransactionsCsv } from "@/server/export";
import { attachmentHeaders, unauthorized } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/export/transactions — the signed-in user's transactions as CSV. Accepts the same filter parameters as
 * /transactions (month, wallet, group (a wallet group id; ignored with `wallet`), kind, category and tag (one id or
 * several, comma-separated), min, max, from, to, q; invalid values are dropped the same way, except an invalid amount
 * bound, which answers 400 with the reason) and exports every matching row. Unlike the list, a missing `month` (or
 * `month=all`) means all time: the list's "Export CSV" link always writes out the month it shows (`exportCsvHref`),
 * and a bare link exports everything.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const sp = request.nextUrl.searchParams;
  const params = parseListParams(Object.fromEntries([...sp.keys()].map((k) => [k, sp.getAll(k)])));
  const amountErrors = amountRangeErrors(params);
  const problem = amountErrors.min ?? amountErrors.max;
  if (problem) {
    return Response.json({ error: problem }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const group = Number(sp.get("group"));
  const csv = await buildTransactionsCsv(user.id, {
    walletId: params.wallet,
    groupId: Number.isSafeInteger(group) && group > 0 ? group : undefined,
    kind: params.kind,
    categoryIds: params.categories,
    tagIds: params.tags,
    minAmount: params.min,
    maxAmount: params.max,
    month: params.month === "all" ? undefined : params.month,
    from: params.from,
    to: params.to,
    q: params.q,
  });
  return new Response(csv, {
    headers: attachmentHeaders(`expenses-tracker-transactions-${todayInZone(user.timeZone)}.csv`, "text/csv; charset=utf-8"),
  });
}
