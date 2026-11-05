// URL ⇄ filters for the /transactions list. Invalid values are dropped, never thrown.

import { isValidDate } from "@/lib/dates";

export const PAGE_SIZE = 50;
const MAX_Q_LENGTH = 200;

export type ListKind = "expense" | "income" | "transfer";

export type ListParams = {
  wallet?: number;
  kind?: ListKind;
  category?: number;
  from?: string;
  to?: string;
  q?: string;
  page: number;
};

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function id(v: string | undefined): number | undefined {
  return v && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : undefined;
}

export function parseListParams(sp: SearchParams): ListParams {
  const kind = first(sp.kind);
  const from = first(sp.from);
  const to = first(sp.to);
  const q = first(sp.q)?.trim().slice(0, MAX_Q_LENGTH);
  const pageRaw = first(sp.page);
  const page = pageRaw && /^[1-9]\d{0,6}$/.test(pageRaw) ? Number(pageRaw) : 1;
  return {
    wallet: id(first(sp.wallet)),
    kind: kind === "expense" || kind === "income" || kind === "transfer" ? kind : undefined,
    category: id(first(sp.category)),
    from: isValidDate(from) ? from : undefined,
    to: isValidDate(to) ? to : undefined,
    q: q || undefined,
    page,
  };
}

export function hasFilters(p: ListParams): boolean {
  return Boolean(p.wallet || p.kind || p.category || p.from || p.to || p.q);
}

/** `/transactions?…` for the given params (empty values and page 1 omitted). */
export function listHref(p: ListParams, overrides: Partial<ListParams> = {}): string {
  const merged = { ...p, ...overrides };
  const qs = new URLSearchParams();
  if (merged.wallet) qs.set("wallet", String(merged.wallet));
  if (merged.kind) qs.set("kind", merged.kind);
  if (merged.category) qs.set("category", String(merged.category));
  if (merged.from) qs.set("from", merged.from);
  if (merged.to) qs.set("to", merged.to);
  if (merged.q) qs.set("q", merged.q);
  if (merged.page > 1) qs.set("page", String(merged.page));
  const s = qs.toString();
  return s ? `/transactions?${s}` : "/transactions";
}
