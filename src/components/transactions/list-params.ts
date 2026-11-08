// URL ⇄ filters for the /transactions list. Invalid values are dropped, never thrown.
//
// `month` is what the URL says (`YYYY-MM` or `all`); absent means the default, the current month — unless `from` or
// `to` is given, which override the month (the service ignores `month` then). `resolveView` turns that into what the
// list shows. `currency` only picks the day strip's currency and is not a filter.

import { isValidCurrency } from "@/lib/currencies";
import { currentMonth, formatDate, formatMonth, isValidDate, isValidMonth } from "@/lib/dates";
// Type-only: this module also runs in the browser (the chip row).
import type { TransactionFilters } from "@/server/transactions";

export const PAGE_SIZE = 50;
const MAX_Q_LENGTH = 200;

export type ListKind = "expense" | "income" | "transfer";

export type ListParams = {
  /** `YYYY-MM` or `"all"` as given in the URL; undefined = the default (current) month. */
  month?: string;
  wallet?: number;
  kind?: ListKind;
  category?: number;
  from?: string;
  to?: string;
  q?: string;
  /** The day strip's currency (`?currency=`); not a filter. */
  currency?: string;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function id(v: string | undefined): number | undefined {
  return v && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : undefined;
}

export function parseListParams(sp: SearchParams): ListParams {
  const month = first(sp.month);
  const kind = first(sp.kind);
  const from = first(sp.from);
  const to = first(sp.to);
  const q = first(sp.q)?.trim().slice(0, MAX_Q_LENGTH);
  const currency = first(sp.currency);
  const pageRaw = first(sp.page);
  const page = pageRaw && /^[1-9]\d{0,6}$/.test(pageRaw) ? Number(pageRaw) : 1;
  return {
    month: month === "all" || isValidMonth(month) ? month : undefined,
    wallet: id(first(sp.wallet)),
    kind: kind === "expense" || kind === "income" || kind === "transfer" ? kind : undefined,
    category: id(first(sp.category)),
    from: isValidDate(from) ? from : undefined,
    to: isValidDate(to) ? to : undefined,
    q: q || undefined,
    currency: currency !== undefined && isValidCurrency(currency) ? currency : undefined,
    page,
  };
}

/** What the list shows: one month, all time, or an explicit `from` / `to` range (which overrides the month). */
export type ListView =
  | { type: "month"; month: string }
  | { type: "all" }
  | { type: "range"; from?: string; to?: string };

export function resolveView(p: ListParams, thisMonth: string = currentMonth()): ListView {
  if (p.from || p.to) return { type: "range", from: p.from, to: p.to };
  if (p.month === "all") return { type: "all" };
  return { type: "month", month: p.month ?? thisMonth };
}

/** True when the month in the URL is something other than the default (current) month. */
function monthIsFilter(p: ListParams, thisMonth: string): boolean {
  return p.month !== undefined && p.month !== thisMonth;
}

/** Any filter set besides the default month (the currency and the page are not filters). */
export function hasFilters(p: ListParams, thisMonth: string = currentMonth()): boolean {
  return Boolean(monthIsFilter(p, thisMonth) || p.wallet || p.kind || p.category || p.from || p.to || p.q);
}

/** Filters other than the month / date range (wallet, type, category, search). */
export function hasNonDateFilters(p: ListParams): boolean {
  return Boolean(p.wallet || p.kind || p.category || p.q);
}

/** The service filters for these params (no paging): the default month is applied when nothing else is given. */
export function listFilters(p: ListParams, thisMonth: string = currentMonth()): TransactionFilters {
  const view = resolveView(p, thisMonth);
  return {
    walletId: p.wallet,
    kind: p.kind,
    categoryId: p.category,
    month: view.type === "month" ? view.month : undefined,
    from: p.from,
    to: p.to,
    q: p.q,
  };
}

/** `/transactions?…` for the given params (empty values and page 1 omitted). */
export function listHref(p: ListParams, overrides: Partial<ListParams> = {}): string {
  const merged = { ...p, ...overrides };
  const qs = new URLSearchParams();
  if (merged.month) qs.set("month", merged.month);
  if (merged.wallet) qs.set("wallet", String(merged.wallet));
  if (merged.kind) qs.set("kind", merged.kind);
  if (merged.category) qs.set("category", String(merged.category));
  if (merged.from) qs.set("from", merged.from);
  if (merged.to) qs.set("to", merged.to);
  if (merged.q) qs.set("q", merged.q);
  if (merged.currency) qs.set("currency", merged.currency);
  if (merged.page > 1) qs.set("page", String(merged.page));
  const s = qs.toString();
  return s ? `/transactions?${s}` : "/transactions";
}

/**
 * The list showing `month` (the current one leaves `month` out of the URL; `"all"` = all time), keeping the other
 * filters and the currency, dropping `from` / `to` and the page.
 */
export function monthHref(p: ListParams, month: string, thisMonth: string = currentMonth()): string {
  return listHref(p, { month: month === thisMonth ? undefined : month, from: undefined, to: undefined, page: 1 });
}

/**
 * A day bar of the strip for `month`: narrows the list to that day (`from=to=<date>`), keeping the month in the URL
 * so clearing the day returns to it. `date` null = back to the whole month.
 */
export function dayHref(p: ListParams, month: string, date: string | null, thisMonth: string = currentMonth()): string {
  return listHref(p, {
    month: month === thisMonth ? undefined : month,
    from: date ?? undefined,
    to: date ?? undefined,
    page: 1,
  });
}

/**
 * `/api/export/transactions?…` carrying the list's filters (not the page or the currency): the "Export CSV" link.
 * The month the list shows is always written out — the export route itself defaults to all time.
 */
export function exportCsvHref(p: ListParams, thisMonth: string = currentMonth()): string {
  const view = resolveView(p, thisMonth);
  const qs = listHref(p, {
    month: view.type === "month" ? view.month : undefined,
    currency: undefined,
    page: 1,
  }).split("?")[1];
  return qs ? `/api/export/transactions?${qs}` : "/api/export/transactions";
}

/** "5 Nov" in `year`, "5 Nov 2025" otherwise. */
function shortDate(date: string, year: string): string {
  const full = formatDate(date);
  return date.slice(0, 4) === year ? full.replace(/ \d{4}$/, "") : full;
}

/** The month chip's text: "November 2026", "All time", "5 Nov – 12 Nov", "5 Nov", "From 5 Nov", "Until 12 Nov". */
export function viewLabel(view: ListView, thisMonth: string = currentMonth()): string {
  if (view.type === "all") return "All time";
  if (view.type === "month") return formatMonth(view.month);
  const year = thisMonth.slice(0, 4);
  const { from, to } = view;
  if (from && to) return from === to ? shortDate(from, year) : `${shortDate(from, year)} – ${shortDate(to, year)}`;
  return from ? `From ${shortDate(from, year)}` : `Until ${shortDate(to!, year)}`;
}

/** The month the day strip shows: the month in view, or the month of a single selected day. Else null. */
export function stripMonth(view: ListView): { month: string; selectedDate?: string } | null {
  if (view.type === "month") return { month: view.month };
  if (view.type === "range" && view.from && view.from === view.to) {
    return { month: view.from.slice(0, 7), selectedDate: view.from };
  }
  return null;
}
