import type { Metadata } from "next";
import { CategorySection } from "@/components/categories/category-section";
import { SpendingSplitCard } from "@/components/categories/spending-split";
import { ConversionNotes, ConvertSwitch } from "@/components/dashboard/conversion";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { CurrencySwitch, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { exchangeRatesEnabled } from "@/lib/config";
import { getGroupScope } from "@/lib/group-scope";
import { spendingSplit } from "@/lib/category-split";
import { currentMonth, isValidMonth, monthRange, todayISO } from "@/lib/dates";
import {
  monthConversionNotes,
  overviewHref,
  ratesHref,
  ratesNeeded,
  resolveOverviewCurrency,
  resolveOverviewView,
} from "@/lib/overview";
import { listCategoriesWithUsage } from "@/server/categories";
import { getConversion, RATES_SOURCE } from "@/server/exchange-rates";
import { getCategoryMonthAmounts, listUserCurrencies, pickDefaultCurrency } from "@/server/insights";
import { listWallets } from "@/server/wallets";

export const metadata: Metadata = { title: "Categories" };

type Props = { searchParams: Promise<{ month?: string | string[]; currency?: string | string[]; view?: string | string[] }> };

export default async function CategoriesPage({ searchParams }: Props) {
  const user = await requireUser();
  const params = await searchParams;
  const { selected } = await getGroupScope();
  const groupId = selected?.id;
  const maxMonth = currentMonth();
  const requested = typeof params.month === "string" && isValidMonth(params.month) ? params.month : maxMonth;
  const month = requested > maxMonth ? maxMonth : requested;

  // Same rule as the Overview: a held `?currency=` wins, else the month's default. With only archived wallets there
  // is no default; their first currency is shown then. No wallets at all → no amounts and no split card.
  const held = [...new Set((await listWallets(user.id, { includeArchived: true, groupId })).map((w) => w.currency))].sort();
  const resolved = await resolveOverviewCurrency(params.currency, held, () =>
    pickDefaultCurrency(user.id, month, { groupId }),
  );
  const currency = resolved.currency ?? held[0] ?? null;
  const explicit = resolved.explicit;

  // "All in <currency>" (default) or "<currency> only", as on the Overview: with a wallet (archived included) in
  // another currency, the month amounts of every wallet are converted into `currency` at each day's rate.
  const canConvert = currency !== null && held.some((c) => c !== currency);
  const view = canConvert ? resolveOverviewView(params.view) : "all";
  const convert =
    canConvert && view === "all" ? await getConversion(user.id, monthRange(month).from, monthRange(month).to) : undefined;
  const usage = await listCategoriesWithUsage(user.id, { month, ...(currency ? { currency } : {}), groupId });
  const converted =
    convert && currency ? await getCategoryMonthAmounts(user.id, { month, currency, groupId, convert }) : null;
  const all = converted ? usage.map((c) => ({ ...c, monthAmountMinor: converted.amounts.get(c.id) ?? 0 })) : usage;
  const split = currency ? spendingSplit(all) : null;
  const activeCurrencies = await listUserCurrencies(user.id, { groupId });
  const showSwitch = currency !== null && (activeCurrencies.length > 1 || !activeCurrencies.includes(currency));
  const lastDate = month === maxMonth ? todayISO() : monthRange(month).to;
  const missing = converted?.missingCurrencies ?? [];
  const toRates = ratesHref(overviewHref(month, explicit ? currency : null, maxMonth, "/categories", view));
  const notes =
    convert && currency
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
  const viewParam: Record<string, string> = view === "only" ? { view } : {};

  return (
    <>
      <PageHeader
        title="Categories"
        description={
          selected
            ? `Add, rename, archive and remove your categories. Amounts and counts are for ${selected.name}.`
            : "Add, rename, archive and remove the categories you file expenses and income under."
        }
        actions={
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
            <MonthSwitcher
              month={month}
              maxMonth={maxMonth}
              basePath="/categories"
              extraParams={explicit && currency ? { currency, ...viewParam } : viewParam}
            />
            {showSwitch && currency && (
              <CurrencySwitch
                currencies={activeCurrencies}
                value={currency}
                hrefFor={(code) => overviewHref(month, code, maxMonth, "/categories", view)}
              />
            )}
            {canConvert && currency && (
              <ConvertSwitch
                currency={currency}
                view={view}
                allHref={overviewHref(month, currency, maxMonth, "/categories")}
                onlyHref={overviewHref(month, currency, maxMonth, "/categories", "only")}
                ratesHref={toRates}
              />
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-4 sm:gap-5">
        {currency && (
          <ConversionNotes
            notes={notes}
            need={convert ? ratesNeeded(currency, missing, convert, lastDate) : []}
            ratesHref={toRates}
            className="-mt-2"
          />
        )}
        {split && currency && <SpendingSplitCard split={split} month={month} currency={currency} />}
        <div className="grid items-start gap-4 sm:gap-5 lg:grid-cols-2">
          <CategorySection
            kind="expense"
            categories={all.filter((c) => c.kind === "expense")}
            currency={currency}
            segments={split?.segments ?? []}
          />
          <CategorySection
            kind="income"
            categories={all.filter((c) => c.kind === "income")}
            currency={currency}
            segments={[]}
          />
        </div>
      </div>
    </>
  );
}
