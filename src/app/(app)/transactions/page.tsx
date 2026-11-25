import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ConversionNotes, ConvertSwitch } from "@/components/dashboard/conversion";
import { RepeatIcon } from "@/components/shell/icons";
import { DayList } from "@/components/transactions/day-list";
import { DayStrip } from "@/components/transactions/day-strip";
import { FilterChips } from "@/components/transactions/filter-chips";
import { MonthLinks } from "@/components/transactions/month-links";
import { MonthStepShortcut } from "@/components/transactions/month-step-shortcut";
import { InlineEditProvider } from "@/components/transactions/inline-edit";
import { NoScriptFilters } from "@/components/transactions/no-script-filters";
import {
  dayHref,
  exportCsvHref,
  hasEmptyParams,
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
import { exchangeRatesEnabled } from "@/lib/config";
import { getGroupScope } from "@/lib/group-scope";
import { formatMonth, monthRange, shiftMonth, todayInZone } from "@/lib/dates";
import { monthConversionNotes, ratesHref, ratesNeeded, resolveOverviewCurrency } from "@/lib/overview";
import { listCategories } from "@/server/categories";
import { toCategoryOptions, toWalletOptions } from "./form-options";
import { getConversion, RATES_SOURCE } from "@/server/exchange-rates";
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
  const sp = await searchParams;
  const params = parseListParams(sp);
  // A no-JS GET form leaves empty fields in the URL (`?q=`, `?wallet=`): show the same list under its clean URL.
  if (hasEmptyParams(sp)) redirect(listHref(params));
  const today = todayInZone(user.timeZone);
  const thisMonth = today.slice(0, 7);
  const view = resolveView(params, thisMonth);
  const { selected, groups } = await getGroupScope();
  const groupId = selected?.id;
  const filters = { ...listFilters(params, thisMonth), groupId };
  const filtered = hasFilters(params, thisMonth);

  const { items, total } = await listTransactions(user.id, {
    ...filters,
    limit: PAGE_SIZE,
    offset: (params.page - 1) * PAGE_SIZE,
  });

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Past the end (e.g. after deleting the last row of the last page): go to the last real page.
  if (params.page > lastPage) redirect(listHref(params, { page: lastPage }));

  const currentHref = listHref(params);
  const wallets = await listWallets(user.id, { includeArchived: true, groupId });
  // Archived categories included: they filter history, and a row that uses one keeps it in its editor.
  const categories = await listCategories(user.id, undefined, { includeArchived: true });
  const anyAtAll = total > 0 || (await listTransactions(user.id, { limit: 1, groupId })).total > 0;
  const totals = await listDayTotals(user.id, filters, [...new Set(items.map((t) => t.date))]);

  // The day strip: only when one month is in view (or one day of it is selected).
  const strip = anyAtAll ? stripMonth(view) : null;
  let stripNode: React.ReactNode = null;
  if (strip && (total > 0 || strip.selectedDate)) {
    const walletFilter = params.wallet ? wallets.find((w) => w.id === params.wallet) : undefined;
    const held = [...new Set(wallets.map((w) => w.currency))];
    const currency = walletFilter
      ? walletFilter.currency
      : (await resolveOverviewCurrency(params.currency, held, () => pickDefaultCurrency(user.id, strip.month, { groupId })))
          .currency;
    if (currency) {
      // "All in <currency>" (default) or "<currency> only", as on the Overview: offered when no wallet filter pins
      // the strip to one wallet and the user holds a wallet (archived included) in another currency.
      const canConvert = !walletFilter && held.some((c) => c !== currency);
      const convertView = canConvert ? (params.view ?? "all") : "all";
      const convert =
        canConvert && convertView === "all"
          ? await getConversion(user.id, monthRange(shiftMonth(strip.month, -1)).from, monthRange(strip.month).to)
          : undefined;
      const timeline = await getMonthTimeline(user.id, {
        month: strip.month,
        currency,
        walletId: walletFilter?.id,
        categoryId: params.category,
        groupId,
        convert,
      });
      const activeCurrencies = await listUserCurrencies(user.id, { groupId });
      const showSwitch = !walletFilter && (activeCurrencies.length > 1 || !activeCurrencies.includes(currency));
      const lastDate = strip.month === thisMonth ? today : monthRange(strip.month).to;
      const missing = timeline.missingCurrencies ?? [];
      const toRates = ratesHref(currentHref);
      const notes = convert
        ? monthConversionNotes({
            currency,
            conv: convert,
            lastDate,
            held,
            missing,
            ratesOn: exchangeRatesEnabled(),
            source: RATES_SOURCE,
          })
        : [];
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
            showSwitch || canConvert ? (
              <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
                {showSwitch && (
                  <CurrencySwitch
                    currencies={activeCurrencies}
                    value={currency}
                    hrefFor={(code) => listHref(params, { currency: code })}
                  />
                )}
                {canConvert && (
                  <ConvertSwitch
                    currency={currency}
                    view={convertView}
                    allHref={listHref(params, { currency, view: undefined })}
                    onlyHref={listHref(params, { currency, view: "only" })}
                    ratesHref={toRates}
                  />
                )}
              </div>
            ) : undefined
          }
          notes={
            <ConversionNotes
              notes={notes}
              need={convert ? ratesNeeded(currency, missing, convert, lastDate) : []}
              ratesHref={toRates}
              className="mt-1"
            />
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
  // The row editors offer every wallet (a transfer can cross groups), not just the selected group's.
  const editWalletOptions = toWalletOptions(
    selected ? await listWallets(user.id, { includeArchived: true }) : wallets,
    groups.length >= 2,
  );
  const categoryOptions = toCategoryOptions(categories);

  // Single-month view: the neighbouring months, for the end-of-list row and the [ / ] keys (not for a day or range).
  const months =
    view.type === "month"
      ? {
          prev: { label: formatMonth(shiftMonth(view.month, -1)), href: monthHref(params, shiftMonth(view.month, -1), thisMonth) },
          next: { label: formatMonth(shiftMonth(view.month, 1)), href: monthHref(params, shiftMonth(view.month, 1), thisMonth) },
        }
      : null;
  // Back to this month (the chip row's link, the end-of-list row and the T key); null when it is already shown.
  const currentMonthHref =
    view.type === "month" && view.month === thisMonth ? null : monthHref(params, thisMonth, thisMonth);

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
      const following = shiftMonth(view.month, 1);
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
              <LinkButton href={monthHref(params, following, thisMonth)} variant="secondary">
                {formatMonth(following)} ›
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
      <PageHeader
        title="Transactions"
        description={anyAtAll ? describeCount(total, params, view, thisMonth) : undefined}
        actions={
          // Not in the top menu: repeating entries are reached from here and from the marker on the entries they made.
          <Link href="/recurring" className={buttonClasses({ variant: "secondary", size: "sm" })}>
            <RepeatIcon className="size-4" />
            Repeating
          </Link>
        }
      />

      {anyAtAll && (
        <FilterChips
          params={params}
          thisMonth={thisMonth}
          wallets={walletOptions}
          categories={categoryOptions}
          exportHref={total > 0 ? exportCsvHref(params, thisMonth, groupId) : null}
          showClear={filtered}
        />
      )}
      {anyAtAll && (
        // Without JavaScript the popover chips cannot open: a plain GET form replaces them.
        <noscript>
          <NoScriptFilters params={params} thisMonth={thisMonth} wallets={walletOptions} categories={categoryOptions} />
        </noscript>
      )}

      <MonthStepShortcut
        prevHref={months?.prev.href ?? null}
        nextHref={months?.next.href ?? null}
        currentHref={currentMonthHref}
      />

      {stripNode}

      {empty ? (
        <Card>{empty}</Card>
      ) : (
        <InlineEditProvider wallets={editWalletOptions} categories={categoryOptions} today={today} returnTo={currentHref}>
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

      <MonthLinks months={months} page={params.page} lastPage={lastPage} total={total} currentHref={currentMonthHref} />
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
