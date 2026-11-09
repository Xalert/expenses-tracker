import { MonthChart } from "@/components/dashboard/month-chart";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { LatestCard, WalletsCard, WalletsViewSwitch } from "@/components/dashboard/overview-lists";
import { PlusIcon, WalletIcon } from "@/components/shell/icons";
import { TransactionList } from "@/components/transaction-list";
import { Card, CardHeader, CurrencySwitch, EmptyState, InsightCard, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { exchangeRatesEnabled } from "@/lib/config";
import { getGroupScope } from "@/lib/group-scope";
import { currentMonth, formatMonth, isValidMonth, monthRange, shiftMonth, todayISO } from "@/lib/dates";
import { convertedTotal } from "@/lib/fx";
import { formatMoney } from "@/lib/money";
import {
  monthName,
  overviewHref,
  paceSummary,
  resolveOverviewCurrency,
  resolveOverviewView,
  toneOf,
  walletsTotalNotes,
} from "@/lib/overview";
import { getDashboard } from "@/server/dashboard";
import { getDailyRates, getExchangeRates, RATES_SOURCE } from "@/server/exchange-rates";
import {
  getMonthInsights,
  getMonthTimeline,
  getWalletMonth,
  listUserCurrencies,
  monthDayN,
  pickDefaultCurrency,
} from "@/server/insights";
import { listWallets } from "@/server/wallets";

type Props = { searchParams: Promise<{ month?: string | string[]; currency?: string | string[]; view?: string | string[] }> };

const LATEST_COUNT = 5;

export default async function OverviewPage({ searchParams }: Props) {
  const user = await requireUser();
  const params = await searchParams;
  const maxMonth = currentMonth();
  const requested = typeof params.month === "string" && isValidMonth(params.month) ? params.month : maxMonth;
  const month = requested > maxMonth ? maxMonth : requested;
  const { selected } = await getGroupScope();
  const groupId = selected?.id;
  const data = getDashboard(user.id, { month, groupId });

  const held = [...new Set(listWallets(user.id, { includeArchived: true, groupId }).map((w) => w.currency))];
  const { currency, explicit } =
    data.wallets.length === 0
      ? { currency: null, explicit: false }
      : resolveOverviewCurrency(params.currency, held, () => pickDefaultCurrency(user.id, month, { groupId }));

  if (currency === null) {
    return (
      <>
        <PageHeader
          title={selected ? selected.name : `Welcome, ${user.displayName}`}
        />
        <Card>
          <EmptyState
            icon={<WalletIcon className="size-8" />}
            title={
              data.recent.length
                ? "No active wallets"
                : selected
                  ? `No wallets in ${selected.name}`
                  : "Create your first wallet"
            }
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

  const isCurrentMonth = month === maxMonth;
  const previousMonth = shiftMonth(month, -1);
  const dayN = monthDayN(month);
  // One view for the whole page. "all" (default): the month figures cover every wallet, converted into `currency`
  // at each day's rate, and the Wallets card shows every active wallet with a converted total. "only": just
  // `currency`, nothing converted. When every wallet (archived included) is in `currency` there is nothing to choose.
  const canSwitchView = held.some((c) => c !== currency);
  const view = canSwitchView ? resolveOverviewView(params.view) : "all";
  const ratesOn = exchangeRatesEnabled();
  const ratesState = (loaded: boolean, quotesTarget: boolean) =>
    !ratesOn ? "off" : !loaded ? "unavailable" : quotesTarget ? "loaded" : "no-target";

  const convertMonth = view === "all" && canSwitchView;
  const dailyRates = convertMonth ? await getDailyRates(monthRange(previousMonth).from, monthRange(month).to) : null;
  const convert = convertMonth ? { rates: dailyRates } : undefined;
  const timeline = getMonthTimeline(user.id, { month, currency, convert, groupId });
  const insights = getMonthInsights(user.id, { month, currency, convert, groupId });
  const money = (minor: number, opts?: { signed?: boolean }) => formatMoney(minor, currency, opts);
  const monthMissing = [
    ...new Set([...(timeline.missingCurrencies ?? []), ...(insights.missingCurrencies ?? [])]),
  ].sort();
  const lastDay = dailyRates?.days.at(-1);
  const monthNotes = convertMonth
    ? [
        ...(dailyRates ? [`All wallets, converted at each day's rate · ${RATES_SOURCE}`] : []),
        ...walletsTotalNotes({
          currency,
          missing: monthMissing,
          ratesDate: null,
          source: RATES_SOURCE,
          ratesState: ratesState(
            dailyRates !== null,
            currency === dailyRates?.base || lastDay?.rates[currency] !== undefined,
          ),
        }),
      ]
    : [];

  // The Wallets card follows the same view.
  const shownWallets = view === "all" ? data.wallets : data.wallets.filter((w) => w.currency === currency);
  const needsRates = shownWallets.some((w) => w.currency !== currency);
  const rates = needsRates ? await getExchangeRates() : null;
  const total = convertedTotal(shownWallets, currency, rates);
  const totalNotes = walletsTotalNotes({
    currency,
    missing: total.missing,
    ratesDate: total.usedRates && rates ? rates.date : null,
    source: RATES_SOURCE,
    ratesState: ratesState(rates !== null, currency === rates?.base || rates?.rates[currency] !== undefined),
  });
  const viewParam: Record<string, string> = view === "only" ? { view } : {};
  const href = (code: string) => overviewHref(month, code, maxMonth, "/", view);

  const changes = new Map<number, number>();
  for (const w of shownWallets) {
    const m = getWalletMonth(user.id, w.id, month);
    changes.set(w.id, m ? m.inMinor - m.outMinor : 0);
  }

  const activeCurrencies = listUserCurrencies(user.id, { groupId });
  const pace = paceSummary({ ...insights.pace, previousMonth, isCurrentMonth });
  const previousName = monthName(previousMonth);
  const { noSpendDays: noSpend, topCategory } = insights;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <section
        aria-labelledby="overview-heading"
        className="flex flex-col gap-4 rounded-[20px] border border-border bg-surface p-4 sm:px-7 sm:py-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 id="overview-heading" className="text-sm font-semibold text-muted-foreground">
              {formatMonth(month)} · {currency}
              {selected && ` · ${selected.name}`}
            </h1>
            <p className="mt-1.5 text-[34px] leading-none font-extrabold tracking-[-0.03em] text-foreground tabular-nums sm:text-[42px]">
              {money(insights.expenseMinor)}{" "}
              <span className="text-base font-semibold tracking-normal text-muted-foreground sm:text-lg">
                {isCurrentMonth ? "spent so far" : "spent"}
              </span>
            </p>
          </div>
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2 sm:justify-end">
            <MonthSwitcher
              month={month}
              maxMonth={maxMonth}
              extraParams={explicit ? { currency, ...viewParam } : viewParam}
            />
            {(activeCurrencies.length > 1 || !activeCurrencies.includes(currency)) && (
              <CurrencySwitch
                currencies={activeCurrencies}
                value={currency}
                hrefFor={href}
              />
            )}
            {canSwitchView && (
              <WalletsViewSwitch
                options={[
                  { label: `All in ${currency}`, href: overviewHref(month, currency, maxMonth), current: view === "all" },
                  {
                    label: `${currency} only`,
                    href: overviewHref(month, currency, maxMonth, "/", "only"),
                    current: view === "only",
                  },
                ]}
              />
            )}
          </div>
        </div>
        {monthNotes.length > 0 && (
          <div className="-mt-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {monthNotes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}

        <MonthChart
          month={month}
          previousMonth={previousMonth}
          currency={currency}
          timeline={timeline}
          dayN={dayN}
          isCurrentMonth={isCurrentMonth}
        />
      </section>

      <div className="grid grid-cols-2 gap-3 sm:gap-3.5 lg:grid-cols-4">
        <InsightCard
          title={isCurrentMonth ? "Net this month" : `Net in ${monthName(month)}`}
          value={money(insights.netMinor, { signed: true })}
          tone={toneOf(insights.netMinor)}
          sub={`In ${money(insights.incomeMinor)} · out ${money(insights.expenseMinor)}`}
        />
        <InsightCard
          title="Top category"
          value={topCategory ? topCategory.categoryName : "—"}
          sub={
            topCategory
              ? `${topCategory.sharePercent}% of spending · ${money(topCategory.amountMinor)}`
              : "No spending this month"
          }
        />
        <InsightCard
          title={`Pace vs ${previousName}`}
          value={money(pace.deltaMinor, { signed: true })}
          tone={pace.tone}
          sub={pace.sub}
        />
        <InsightCard
          title="No-spend days"
          value={`${noSpend.days} of ${noSpend.outOf}`}
          sub={`${previousName} had ${noSpend.previousDays} of ${noSpend.previousOutOf}`}
        />
      </div>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <WalletsCard
          wallets={shownWallets}
          changes={changes}
          total={{
            currency,
            totalMinor: total.totalMinor,
            notes: totalNotes,
            approximate: total.usedRates,
          }}
          converted={total.converted}
          changeLabel={isCurrentMonth ? "this month" : `in ${monthName(month)}`}
          hrefFor={(id) => (isCurrentMonth ? `/wallets/${id}` : `/wallets/${id}?month=${month}`)}
        />
        <LatestCard items={data.recent.slice(0, LATEST_COUNT)} today={todayISO()} />
      </div>
    </div>
  );
}
