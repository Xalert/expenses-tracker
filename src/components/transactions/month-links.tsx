import { LinkButton } from "@/components/ui";

export type NeighbourMonths = { prev: { label: string; href: string }; next: { label: string; href: string } };

/**
 * "‹ October 2026" / "December 2026 ›" under the list, so a month read to its end continues without scrolling back
 * up. Only in a single-month view and only on the last page (or the only one) of a non-empty list.
 */
export function MonthLinks({
  months,
  page,
  lastPage,
  total,
  currentHref = null,
}: {
  months: NeighbourMonths | null;
  /** "This month" in the middle of the row; null when the list already shows this month. */
  currentHref?: string | null;
  page: number;
  lastPage: number;
  total: number;
}) {
  if (!months || total === 0 || page !== lastPage) return null;
  return (
    <nav aria-label="Months" className="mt-3 flex items-center justify-between gap-3">
      <LinkButton href={months.prev.href} variant="secondary" scroll={false}>
        ‹ {months.prev.label}
      </LinkButton>
      {currentHref && (
        <LinkButton href={currentHref} variant="ghost" scroll={false} title="This month (T)">
          This month
        </LinkButton>
      )}
      <LinkButton href={months.next.href} variant="secondary" scroll={false}>
        {months.next.label} ›
      </LinkButton>
    </nav>
  );
}
