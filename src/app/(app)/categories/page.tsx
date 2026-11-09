import type { Metadata } from "next";
import { CategorySection } from "@/components/categories/category-section";
import { SpendingSplitCard } from "@/components/categories/spending-split";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { CurrencySwitch, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getGroupScope } from "@/lib/group-scope";
import { spendingSplit } from "@/lib/category-split";
import { currentMonth, isValidMonth } from "@/lib/dates";
import { overviewHref, resolveOverviewCurrency } from "@/lib/overview";
import { listCategoriesWithUsage } from "@/server/categories";
import { listUserCurrencies, pickDefaultCurrency } from "@/server/insights";
import { listWallets } from "@/server/wallets";

export const metadata: Metadata = { title: "Categories" };

type Props = { searchParams: Promise<{ month?: string | string[]; currency?: string | string[] }> };

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
  const held = [...new Set(listWallets(user.id, { includeArchived: true, groupId }).map((w) => w.currency))].sort();
  const resolved = resolveOverviewCurrency(params.currency, held, () => pickDefaultCurrency(user.id, month, { groupId }));
  const currency = resolved.currency ?? held[0] ?? null;
  const explicit = resolved.explicit;

  const all = listCategoriesWithUsage(user.id, { month, ...(currency ? { currency } : {}), groupId });
  const split = currency ? spendingSplit(all) : null;
  const activeCurrencies = listUserCurrencies(user.id, { groupId });
  const showSwitch = currency !== null && (activeCurrencies.length > 1 || !activeCurrencies.includes(currency));

  return (
    <>
      <PageHeader
        title="Categories"
        description={
          selected
            ? `Add, rename and remove your categories. Amounts and counts are for ${selected.name}.`
            : "Add, rename and remove the categories you file expenses and income under."
        }
        actions={
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
            <MonthSwitcher
              month={month}
              maxMonth={maxMonth}
              basePath="/categories"
              extraParams={explicit && currency ? { currency } : undefined}
            />
            {showSwitch && currency && (
              <CurrencySwitch
                currencies={activeCurrencies}
                value={currency}
                hrefFor={(code) => overviewHref(month, code, maxMonth, "/categories")}
              />
            )}
          </div>
        }
      />
      <div className="flex flex-col gap-4 sm:gap-5">
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
