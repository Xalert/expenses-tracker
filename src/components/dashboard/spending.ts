import type { CategorySpend } from "@/server/dashboard";

export type CurrencySpending = {
  currency: string;
  totalMinor: number;
  rows: { categoryId: number; categoryName: string; amountMinor: number; /** 0–100, relative to the largest row */ barPercent: number; /** 0–100 share of the currency's total */ sharePercent: number }[];
};

/** Group per-category spending by currency (never mixing currencies), largest first within each group. */
export function groupSpendingByCurrency(items: CategorySpend[]): CurrencySpending[] {
  const groups = new Map<string, CategorySpend[]>();
  for (const it of items) {
    if (it.amountMinor <= 0) continue;
    const list = groups.get(it.currency) ?? [];
    list.push(it);
    groups.set(it.currency, list);
  }
  return [...groups.entries()]
    .map(([currency, list]) => {
      const sorted = [...list].sort((a, b) => b.amountMinor - a.amountMinor || a.categoryName.localeCompare(b.categoryName));
      const totalMinor = sorted.reduce((s, r) => s + r.amountMinor, 0);
      const max = sorted[0]?.amountMinor ?? 0;
      return {
        currency,
        totalMinor,
        rows: sorted.map((r) => ({
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          amountMinor: r.amountMinor,
          barPercent: max > 0 ? Math.max(2, Math.round((r.amountMinor / max) * 100)) : 0,
          sharePercent: totalMinor > 0 ? Math.round((r.amountMinor / totalMinor) * 100) : 0,
        })),
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
