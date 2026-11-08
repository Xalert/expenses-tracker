import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DayList } from "@/components/transactions/day-list";
import { DayStrip } from "@/components/transactions/day-strip";
import { FilterChips } from "@/components/transactions/filter-chips";
import { InlineEditProvider } from "@/components/transactions/inline-edit";
import {
  dayHref,
  exportCsvHref,
  hasFilters,
  hasNonDateFilters,
  listFilters,
  listHref,
  monthHref,
  PAGE_SIZE,
  parseListParams,
  resolveView,
  stripMonth,
  type ListParams,
  type ListView,
} from "@/components/transactions/list-params";
import { Card, CurrencySwitch, EmptyState, LinkButton, PageHeader, buttonClasses } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { currentMonth, formatMonth, shiftMonth, todayISO } from "@/lib/dates";
import { resolveOverviewCurrency } from "@/lib/overview";
import { listCategories } from "@/server/categories";
import { getMonthTimeline, listUserCurrencies, pickDefaultCurrency } from "@/server/insights";
import { listDayTotals, listTransactions } from "@/server/transactions";
import { listWallets } from "@/server/wallets";

export const metadata: Metadata = { title: "Transactions" };

/** "12 entries this month", "12 entries in October 2026", "12 entries" (all time), "3 match your filters". */
function describeCount(total: number, params: ListParams, view: ListView, thisMonth: string): string {
  if (hasNonDateFilters(params) || view.type === "range") {
    return `${total} ${total === 1 ? "matches" : "match"} your filters`;
  }
  const n = `${total} ${total === 1 ? "entry" : "entries"}`;
  if (view.type === "all") return n;
  return view.month === thisMonth ? `${n} this month` : `${n} in ${formatMonth(view.month)}`;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = parseListParams(await searchParams);
  const thisMonth = currentMonth();
  const today = todayISO();
  const view = resolveView(params, thisMonth);
  const filters = listFilters(params, thisMonth);
  const filtered = hasFilters(params, thisMonth);

  const { items, total } = listTransactions(user.id, {
    ...filters,
    limit: PAGE_SIZE,
    offset: (params.page - 1) * PAGE_SIZE,
  });

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Past the end (e.g. after deleting the last row of the last page): go to the last real page.
  if (params.page > lastPage) redirect(listHref(params, { page: lastPage }));

  const currentHref = listHref(params);
  const wallets = listWallets(user.id, { includeArchived: true });
  const categories = listCategories(user.id);
  const anyAtAll = total > 0 || listTransactions(user.id, { limit: 1 }).total > 0;
  const totals = listDayTotals(user.id, filters, [...new Set(items.map((t) => t.date))]);

  // The day strip: only when one month is in view (or one day of it is selected).
  const strip = anyAtAll ? stripMonth(view) : null;
  let stripNode: React.ReactNode = null;
  if (strip && (total > 0 || strip.selectedDate)) {
    const walletFilter = params.wallet ? wallets.find((w) => w.id === params.wallet) : undefined;
    const held = [...new Set(wallets.map((w) => w.currency))];
    const currency = walletFilter
      ? walletFilter.currency
      : resolveOverviewCurrency(params.currency, held, () => pickDefaultCurrency(user.id, strip.month)).currency;
    if (currency) {
      const timeline = getMonthTimeline(user.id, {
        month: strip.month,
        currency,
        walletId: walletFilter?.id,
        categoryId: params.category,
      });
      const activeCurrencies = listUserCurrencies(user.id);
      const showSwitch = !walletFilter && (activeCurrencies.length > 1 || !activeCurrencies.includes(currency));
      stripNode = (
        <DayStrip
          month={strip.month}
          currency={currency}
          timeline={timeline}
          today={today}
          selectedDate={strip.selectedDate}
          hrefFor={(date) => dayHref(params, strip.month, date, thisMonth)}
          monthHref={dayHref(params, strip.month, null, thisMonth)}
          currencySwitch={
            showSwitch ? (
              <CurrencySwitch
                currencies={activeCurrencies}
                value={currency}
                hrefFor={(code) => listHref(params, { currency: code })}
              />
            ) : undefined
          }
        />
      );
    }
  }

  const first = total === 0 ? 0 : (params.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(params.page * PAGE_SIZE, total);
  const walletOptions = wallets.map((w) => ({
    id: w.id,
    name: w.name,
    currency: w.currency,
    archived: w.archivedAt !== null,
  }));
  const categoryOptions = categories.map(({ id, name, kind }) => ({ id, name, kind }));

  let empty: React.ReactNode = null;
  if (total === 0) {
    if (!anyAtAll) {
      empty =
        wallets.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            description="Create a wallet first, then start logging your expenses and income."
            action={<LinkButton href="/wallets/new">Create a wallet</LinkButton>}
          />
        ) : (
          <EmptyState
            title="No transactions yet"
            description="Log an expense, an income or a transfer between your wallets."
            action={<LinkButton href="/transactions/new">Add a transaction</LinkButton>}
          />
        );
    } else if (view.type === "month" && !hasNonDateFilters(params)) {
      const previous = shiftMonth(view.month, -1);
      empty = (
        <EmptyState
          title={`Nothing in ${formatMonth(view.month)}.`}
          description="No expenses, income or transfers are dated in this month."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href={monthHref(params, previous, thisMonth)} variant="secondary">
                ‹ {formatMonth(previous)}
              </LinkButton>
              <LinkButton href={monthHref(params, "all", thisMonth)} variant="secondary">
                All time
              </LinkButton>
            </div>
          }
        />
      );
    } else {
      empty = (
        <EmptyState
          title="No matching transactions"
          description="Nothing matches these filters. Try another month or clear a filter."
          action={
            <LinkButton href="/transactions" variant="secondary">
              Clear filters
            </LinkButton>
          }
        />
      );
    }
  }

  return (
    <>
      <PageHeader title="Transactions" description={anyAtAll ? describeCount(total, params, view, thisMonth) : undefined} />

      {anyAtAll && (
        <FilterChips
          params={params}
          thisMonth={thisMonth}
          wallets={walletOptions}
          categories={categoryOptions}
          exportHref={total > 0 ? exportCsvHref(params, thisMonth) : null}
          showClear={filtered}
        />
      )}

      {stripNode}

      {empty ? (
        <Card>{empty}</Card>
      ) : (
        <InlineEditProvider wallets={walletOptions} categories={categoryOptions} today={today} returnTo={currentHref}>
          <DayList items={items} totals={totals} today={today} returnTo={currentHref} />
        </InlineEditProvider>
      )}

      {total > 0 && (
        <nav
          aria-label="Pagination"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <p className="tabular-nums">
            Showing {first}–{last} of {total}
          </p>
          {lastPage > 1 && (
            <div className="flex items-center gap-2">
              <PageLink href={params.page > 1 ? listHref(params, { page: params.page - 1 }) : null} rel="prev">
                Previous
              </PageLink>
              <span className="tabular-nums">
                Page {params.page} of {lastPage}
              </span>
              <PageLink href={params.page < lastPage ? listHref(params, { page: params.page + 1 }) : null} rel="next">
                Next
              </PageLink>
            </div>
          )}
        </nav>
      )}
    </>
  );
}

function PageLink({ href, rel, children }: { href: string | null; rel: "prev" | "next"; children: React.ReactNode }) {
  const cls = buttonClasses({ variant: "secondary", size: "sm" });
  if (!href) {
    return (
      <span className={`${cls} pointer-events-none opacity-50`} aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <Link href={href} rel={rel} className={cls}>
      {children}
    </Link>
  );
}
