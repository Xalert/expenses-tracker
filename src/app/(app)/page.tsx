import Link from "next/link";
import { CategorySpending } from "@/components/dashboard/category-spending";
import { CurrencyTotals } from "@/components/dashboard/currency-totals";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { PlusIcon, WalletIcon } from "@/components/shell/icons";
import { TransactionList } from "@/components/transaction-list";
import { Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { WalletCard } from "@/components/wallets/wallet-card";
import { requireUser } from "@/lib/auth";
import { currentMonth, formatMonth, isValidMonth } from "@/lib/dates";
import { getDashboard } from "@/server/dashboard";

type Props = { searchParams: Promise<{ month?: string | string[] }> };

export default async function DashboardPage({ searchParams }: Props) {
  const user = await requireUser();
  const maxMonth = currentMonth();
  const raw = (await searchParams).month;
  const requested = typeof raw === "string" && isValidMonth(raw) ? raw : maxMonth;
  const month = requested > maxMonth ? maxMonth : requested;
  const data = getDashboard(user.id, { month });
  const firstName = user.name.split(" ")[0];

  if (data.wallets.length === 0) {
    return (
      <>
        <PageHeader title={`Welcome, ${firstName}`} />
        <Card>
          <EmptyState
            icon={<WalletIcon className="size-8" />}
            title={data.recent.length ? "No active wallets" : "Create your first wallet"}
            description={
              data.recent.length
                ? "All your wallets are archived. Create a new one or unarchive one from the Wallets page."
                : "A wallet is a bank account, card or cash pocket in one currency. Add one, then start logging income and expenses."
            }
            action={
              <LinkButton href="/wallets/new">
                <PlusIcon className="size-4" />
                New wallet
              </LinkButton>
            }
          />
        </Card>
        {data.recent.length > 0 && (
          <Card className="mt-6">
            <CardHeader title="Recent transactions" />
            <TransactionList items={data.recent} />
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Dashboard" description={`Hello, ${firstName}.`} actions={<MonthSwitcher month={month} maxMonth={maxMonth} />} />

      <div className="space-y-8">
        <section aria-labelledby="wallets-heading">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 id="wallets-heading" className="text-sm font-semibold text-muted-foreground">
              Wallets
            </h2>
            <Link href="/wallets" className="text-sm font-medium text-accent hover:underline">
              Manage
            </Link>
          </div>
          <ul className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
            {data.wallets.map((w) => (
              <li key={w.id}>
                <WalletCard wallet={w} className="h-full" />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="totals-heading">
          <h2 id="totals-heading" className="mb-3 text-sm font-semibold text-muted-foreground">
            Totals per currency · {formatMonth(month)}
          </h2>
          <CurrencyTotals totals={data.totalsByCurrency} />
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Spending by category" description={formatMonth(month)} />
            <CategorySpending items={data.expenseByCategory} emptyMessage={`No expenses in ${formatMonth(month)}.`} />
          </Card>

          <Card>
            <CardHeader
              title="Recent transactions"
              actions={
                <LinkButton href="/transactions" size="sm" variant="ghost">
                  View all
                </LinkButton>
              }
            />
            <TransactionList items={data.recent} emptyMessage="No transactions yet." />
          </Card>
        </div>
      </div>
    </>
  );
}
