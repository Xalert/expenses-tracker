import type { Metadata } from "next";
import { ConversionNotes, ConvertSwitch } from "@/components/dashboard/conversion";
import { CategoryYearTable } from "@/components/reports/category-year-table";
import { YearChart } from "@/components/reports/year-chart";
import { YearStepper } from "@/components/reports/year-stepper";
import { ChartIcon, PlusIcon, WalletIcon } from "@/components/shell/icons";
import { listHref } from "@/components/transactions/list-params";
import { Card, CurrencySwitch, EmptyState, InsightCard, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { exchangeRatesEnabled } from "@/lib/config";
import { getGroupScope } from "@/lib/group-scope";
import { todayInZone } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import {
  monthConversionNotes,
  overviewHref,
  ratesHref,
  ratesNeeded,
  resolveOverviewCurrency,
  resolveOverviewView,
  toneOf,
} from "@/lib/overview";
import { comparisonSub, periodLabel, reportsHref, resolveReportYear } from "@/lib/reports";
import { getConversion, RATES_SOURCE } from "@/server/exchange-rates";
import { listUserCurrencies, pickDefaultCurrencyBetween } from "@/server/insights";
import { getYearReport } from "@/server/reports";
import { listWallets } from "@/server/wallets";

export const metadata: Metadata = { title: "Reports" };

type Props = { searchParams: Promise<{ year?: string | string[]; currency?: string | string[]; view?: string | string[] }> };

/**
 * /reports — one year: its totals against the previous year, a month-by-month chart and the category-by-month tables.
 * Currency, "All in <currency>" and the wallet-group scope work exactly as on the Overview.
 */
export default async function ReportsPage({ searchParams }: Props) {
  const user = await requireUser();
  const params = await searchParams;
  const today = todayInZone(user.timeZone);
  const maxYear = today.slice(0, 4);
  const year = resolveReportYear(params.year, maxYear);
  const isCurrentYear = year === maxYear;
  const { selected } = await getGroupScope();
  const groupId = selected?.id;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  // The Overview's rule: a held `?currency=` (archived wallets included) wins, else the year's busiest currency; with
  // only archived wallets their first currency by code.
  const held = [...new Set((await listWallets(user.id, { includeArchived: true, groupId })).map((w) => w.currency))].sort();
  const resolved = await resolveOverviewCurrency(params.currency, held, () =>
    pickDefaultCurrencyBetween(user.id, from, to, { groupId }),
  );
  const currency = resolved.currency ?? held[0] ?? null;

  if (currency === null) {
    return (
      <>
        <PageHeader title="Reports" />
        <Card>
          <EmptyState
            icon={<WalletIcon className="size-8" />}
            title={selected ? `No wallets in ${selected.name}` : "Create your first wallet"}
            description="Reports add up a whole year of your income and expenses, month by month and by category."
            action={
              <LinkButton href="/wallets/new">
                <PlusIcon className="size-4" />
                New wallet
              </LinkButton>
            }
          />
        </Card>
      </>
    );
  }

  const explicit = resolved.explicit;
  const canSwitchView = held.some((c) => c !== currency);
  const view = canSwitchView ? resolveOverviewView(params.view) : "all";
  // One conversion for the shown and the previous year (the comparison needs both): one range of provider days, so
  // at most one request, and none when the stored days already cover it.
  const convert =
    canSwitchView && view === "all" ? await getConversion(user.id, `${Number(year) - 1}-01-01`, to) : undefined;
  const report = await getYearReport(user.id, { year, currency, today, groupId, convert });
  const activeCurrencies = await listUserCurrencies(user.id, { groupId });

  const lastDate = isCurrentYear ? today : to;
  const missing = report.missingCurrencies ?? [];
  const here = reportsHref(year, explicit ? currency : null, maxYear, view);
  const toRates = ratesHref(here);
  const notes = convert
    ? monthConversionNotes({ currency, conv: convert, lastDate, held, missing, ratesOn: exchangeRatesEnabled(), source: RATES_SOURCE })
    : [];
  const need = convert ? ratesNeeded(currency, missing, convert, lastDate) : [];
  const elapsed = isCurrentYear ? Number(today.slice(5, 7)) : 12;
  const money = (minor: number, signed = false) => formatMoney(minor, currency, { signed });
  const viewOnly = view === "only" ? ("only" as const) : undefined;
  const stripParams = { page: 1, currency, view: viewOnly };
  const { totals, comparison } = report;
  const isEmpty = report.expenseCategories.length === 0 && report.incomeCategories.length === 0;
  const sub = (measure: "income" | "expense" | "net") => {
    const key = measure === "income" ? "incomeMinor" : measure === "expense" ? "expenseMinor" : "netMinor";
    return comparisonSub({
      measure,
      total: totals[key],
      current: comparison.current[key],
      previous: comparison.previous[key],
      previousYear: comparison.previousYear,
      currency,
      through: comparison.through?.current ?? null,
      previousEmpty: comparison.previous.incomeMinor === 0 && comparison.previous.expenseMinor === 0,
    });
  };

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${year} · ${currency}${selected ? ` · ${selected.name}` : ""}`}
        actions={
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
            <YearStepper
              year={year}
              maxYear={maxYear}
              hrefFor={(y) => reportsHref(y, explicit ? currency : null, maxYear, view)}
            />
            {(activeCurrencies.length > 1 || !activeCurrencies.includes(currency)) && (
              <CurrencySwitch
                currencies={activeCurrencies}
                value={currency}
                hrefFor={(code) => reportsHref(year, code, maxYear, view)}
              />
            )}
            {canSwitchView && (
              <ConvertSwitch
                currency={currency}
                view={view}
                allHref={reportsHref(year, currency, maxYear)}
                onlyHref={reportsHref(year, currency, maxYear, "only")}
                ratesHref={toRates}
              />
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-4 sm:gap-5">
        <ConversionNotes notes={notes} need={need} ratesHref={toRates} className="-mt-2" />

        {isEmpty ? (
          <Card>
            <EmptyState
              icon={<ChartIcon className="size-8" />}
              title={`No entries in ${year}`}
              description={`There is no income or expense${view === "only" || !canSwitchView ? ` in ${currency}` : ""} dated in ${year}${selected ? ` in ${selected.name}` : ""}. Transfers between wallets are not counted.`}
            />
          </Card>
        ) : (
          <>
            <section aria-labelledby="year-totals" className="flex flex-col gap-2">
              <h2 id="year-totals" className="text-sm font-semibold text-muted-foreground">
                {comparison.through
                  ? `${year} so far, against the same period of ${comparison.previousYear} (${periodLabel(comparison.through.current)})`
                  : `The whole of ${year}, against ${comparison.previousYear}`}
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3.5">
                <InsightCard title="Income" value={money(totals.incomeMinor)} tone="income" sub={sub("income")} />
                <InsightCard title="Expenses" value={money(totals.expenseMinor)} sub={sub("expense")} />
                <InsightCard
                  title="Net"
                  value={money(totals.netMinor, true)}
                  tone={toneOf(totals.netMinor)}
                  sub={sub("net")}
                  className="col-span-2 sm:col-span-1"
                />
              </div>
            </section>

            <section
              aria-labelledby="year-months"
              className="flex flex-col gap-3 rounded-[20px] border border-border bg-surface p-4 sm:px-7 sm:py-6"
            >
              <h2 id="year-months" className="text-base font-semibold text-foreground">
                Month by month
              </h2>
              <YearChart
                year={year}
                currency={currency}
                months={report.months}
                elapsed={elapsed}
                hrefFor={(month) => overviewHref(month, currency, `${maxYear}-${today.slice(5, 7)}`, "/", view)}
              />
            </section>

            {(["expense", "income"] as const).map((kind) => (
              <CategoryYearTable
                key={kind}
                kind={kind}
                year={year}
                currency={currency}
                rows={kind === "expense" ? report.expenseCategories : report.incomeCategories}
                monthTotals={report.months.map((m) => (kind === "expense" ? m.expenseMinor : m.incomeMinor))}
                total={kind === "expense" ? totals.expenseMinor : totals.incomeMinor}
                elapsed={elapsed}
                hrefs={{
                  cell: (category, month) => listHref({ ...stripParams, month, category }),
                  rowTotal: (category) => listHref({ ...stripParams, category, from, to }),
                  monthTotal: (month) => listHref({ ...stripParams, month, kind }),
                }}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}
