import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { AddButton } from "@/components/shell/add-button";
import { DayList } from "@/components/transactions/day-list";
import { InlineEditProvider } from "@/components/transactions/inline-edit";
import { InsightCard, LinkButton } from "@/components/ui";
import { WalletMenu } from "@/components/wallets/wallet-menu";
import { WalletMonthChart } from "@/components/wallets/wallet-month-chart";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { currencyName } from "@/lib/currencies";
import { currentMonth, formatMonth, isValidMonth, todayISO } from "@/lib/dates";
import { balanceAfterLabel } from "@/lib/day-labels";
import { formatMoney } from "@/lib/money";
import { monthName } from "@/lib/overview";
import { listCategories } from "@/server/categories";
import { getWalletMonth } from "@/server/insights";
import { listTransactions } from "@/server/transactions";
import { getWallet, listWallets } from "@/server/wallets";
import { parseWalletId } from "../form-input";

/** The month's entries on this page: no pagination here; "Open in Transactions" has the full list. */
const MONTH_LIMIT = 200;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = await getCurrentUser();
  const walletId = parseWalletId((await params).id);
  const wallet = user && walletId ? getWallet(user.id, walletId) : null;
  return { title: wallet?.name ?? "Wallet" };
}

const KIND_PILLS = [
  { kind: "expense", label: "Expense", dot: "bg-expense-dot" },
  { kind: "income", label: "Income", dot: "bg-income" },
  { kind: "transfer", label: "Transfer", dot: "bg-transfer" },
] as const;

export default async function WalletPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const walletId = parseWalletId((await params).id);
  const wallet = walletId ? getWallet(user.id, walletId) : null;
  if (!wallet) notFound();

  const sp = await searchParams;
  const maxMonth = currentMonth();
  const requested = typeof sp.month === "string" && isValidMonth(sp.month) ? sp.month : maxMonth;
  const month = requested > maxMonth ? maxMonth : requested;
  const isCurrentMonth = month === maxMonth;
  const today = todayISO();
  const data = getWalletMonth(user.id, wallet.id, month);
  if (!data) notFound();

  const archived = wallet.archivedAt !== null;
  const self = `/wallets/${wallet.id}`;
  const pageHref = isCurrentMonth ? self : `${self}?month=${month}`;
  const money = (minor: number, opts?: { signed?: boolean }) => formatMoney(minor, wallet.currency, opts);
  const { items, total } = listTransactions(user.id, { walletId: wallet.id, month, limit: MONTH_LIMIT });
  const closingByDate = new Map(data.days.map((d) => [d.date, d.closingMinor]));
  const endMinor = data.days.at(-1)?.closingMinor ?? data.openingMinor;
  const sinceStart = endMinor - data.openingMinor;
  const name = monthName(month);

  const walletOptions = listWallets(user.id, { includeArchived: true }).map((w) => ({
    id: w.id,
    name: w.name,
    currency: w.currency,
    archived: w.archivedAt !== null,
  }));
  const categoryOptions = listCategories(user.id).map(({ id, name, kind }) => ({ id, name, kind }));
  const transactionsHref = `/transactions?wallet=${wallet.id}&month=${month}`;

  return (
    <>
      {!archived && <AddButton href={`/transactions/new?wallet=${wallet.id}`} />}

      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <ol className="flex min-w-0 items-center gap-1.5">
          <li>
            <Link href="/wallets" className="font-semibold text-muted-foreground hover:text-foreground hover:underline">
              Wallets
            </Link>
          </li>
          <li aria-hidden="true" className="text-muted-foreground">
            /
          </li>
          <li aria-current="page" className="min-w-0 truncate font-semibold text-foreground">
            {wallet.name}
          </li>
        </ol>
      </nav>

      <div className="flex flex-col gap-4 sm:gap-5">
        <section
          aria-labelledby="wallet-heading"
          className="flex flex-col gap-5 rounded-[20px] border border-border bg-surface p-4 sm:px-7 sm:py-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 id="wallet-heading" className="min-w-0 truncate text-[22px] font-extrabold text-foreground">
                  {wallet.name}
                </h1>
                <span
                  className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs font-bold text-foreground"
                  title={currencyName(wallet.currency)}
                >
                  {wallet.currency}
                </span>
                {archived && (
                  <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
                    Archived
                  </span>
                )}
              </div>
              <p
                className={cn(
                  "mt-2 text-[36px] leading-none font-extrabold tracking-[-0.03em] tabular-nums sm:text-[44px]",
                  wallet.balanceMinor < 0 ? "text-expense" : "text-foreground",
                )}
              >
                {money(wallet.balanceMinor)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Balance today · started with {money(wallet.initialBalanceMinor)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!archived &&
                KIND_PILLS.map((p) => (
                  <LinkButton
                    key={p.kind}
                    variant="secondary"
                    href={`/transactions/new?wallet=${wallet.id}&kind=${p.kind}&returnTo=${encodeURIComponent(pageHref)}`}
                  >
                    <span className={cn("size-2 rounded-full", p.dot)} aria-hidden="true" />
                    {p.label}
                  </LinkButton>
                ))}
              <WalletMenu
                walletId={wallet.id}
                walletName={wallet.name}
                archived={archived}
                canDelete={wallet.transactionCount === 0}
              />
            </div>
          </div>

          {archived && (
            <p className="rounded-2xl bg-surface-muted px-4 py-3 text-sm text-muted-foreground">
              This wallet is archived: it&apos;s hidden from the Overview and the pickers and can&apos;t take new
              entries. Unarchive it from the ⋯ menu to use it again.
            </p>
          )}

          <div className="flex flex-col gap-3 border-t border-surface-muted pt-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">Balance through {formatMonth(month)}</h2>
              <MonthSwitcher month={month} maxMonth={maxMonth} basePath={self} />
            </div>
            <WalletMonthChart
              walletName={wallet.name}
              month={month}
              currency={wallet.currency}
              data={data}
              isCurrentMonth={isCurrentMonth}
            />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3 sm:gap-3.5 lg:grid-cols-4">
          <InsightCard
            title={isCurrentMonth ? "In this month" : `In during ${name}`}
            value={money(data.inMinor)}
            tone={data.inMinor > 0 ? "income" : "default"}
          />
          <InsightCard title={isCurrentMonth ? "Out this month" : `Out during ${name}`} value={money(data.outMinor)} />
          <InsightCard
            title={isCurrentMonth ? "Started the month at" : `Started ${name} at`}
            value={money(data.openingMinor)}
            sub={
              sinceStart === 0
                ? isCurrentMonth
                  ? "No change so far"
                  : "No change over the month"
                : `${sinceStart > 0 ? "Up" : "Down"} ${money(Math.abs(sinceStart))} ${isCurrentMonth ? "since" : "over the month"}`
            }
          />
          <InsightCard
            title="Entries"
            value={String(data.entryCount)}
            sub={`${isCurrentMonth ? "this month" : `in ${name}`} · ${data.totalEntryCount} in total`}
          />
        </div>

        <section aria-labelledby="wallet-entries" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
            <h2 id="wallet-entries" className="text-[15px] font-bold text-foreground">
              Entries in {formatMonth(month)}
            </h2>
            <Link href={transactionsHref} className="text-[13px] font-semibold text-accent-hover hover:underline">
              Open in Transactions
            </Link>
          </div>
          {items.length === 0 ? (
            <p className="rounded-[18px] border border-border bg-surface px-4 py-8 text-center text-sm text-muted-foreground">
              {archived
                ? `No entries in ${formatMonth(month)}.`
                : `No entries in ${formatMonth(month)}. Add one with the buttons above.`}
            </p>
          ) : (
            <InlineEditProvider wallets={walletOptions} categories={categoryOptions} today={today} returnTo={pageHref}>
              <DayList
                items={items}
                today={today}
                returnTo={pageHref}
                showWallet={false}
                aside={(date) => {
                  const closing = closingByDate.get(date);
                  return closing === undefined ? null : balanceAfterLabel(closing, wallet.currency);
                }}
              />
            </InlineEditProvider>
          )}
          {total > items.length && (
            <p className="px-1 text-sm text-muted-foreground">
              Showing the latest {items.length} of {total} entries in {formatMonth(month)}.{" "}
              <Link href={transactionsHref} className="font-semibold text-accent-hover hover:underline">
                See them all in Transactions
              </Link>
            </p>
          )}
        </section>
      </div>
    </>
  );
}
