import Link from "next/link";
import { cn } from "@/lib/cn";
import { currencyName } from "@/lib/currencies";
import { formatMoney } from "@/lib/money";
import { changeLabel, entryCountLabel, isFlat, sparklinePoints } from "@/lib/wallet-chart";
import type { WalletView } from "@/server/wallets";
import { unarchiveWalletAction } from "@/app/(app)/wallets/actions";
import { ActionButton } from "./action-button";

/** This month's figures for one wallet card (from `getWalletMonth`). */
export type WalletCardMonth = { openingMinor: number; changeMinor: number; closings: number[] };

/**
 * The small balance line of a wallet card: a 120×40 inline SVG from the opening balance through each day's closing so
 * far (`sparklinePoints`), coloured by the month's change; flat and `--border-strong` when nothing changed.
 * Decorative (`aria-hidden`): the card's change line says the same in words.
 */
export function BalanceSparkline({ month }: { month: WalletCardMonth }) {
  const flat = isFlat(month.openingMinor, month.closings);
  const tone = flat
    ? "text-border-strong"
    : month.changeMinor > 0
      ? "text-income"
      : month.changeMinor < 0
        ? "text-expense"
        : "text-foreground";
  return (
    <svg
      viewBox="0 0 120 40"
      width="120"
      height="40"
      aria-hidden="true"
      className={cn("h-10 w-[120px] shrink-0 overflow-visible", tone)}
    >
      <polyline
        points={sparklinePoints(month.openingMinor, month.closings)}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** One active wallet: name, entry count, balance, this month's change and the balance line; links to its page. */
export function WalletTile({ wallet, month }: { wallet: WalletView; month: WalletCardMonth }) {
  const change = month.changeMinor;
  return (
    <li className="min-w-0">
      <Link
        href={`/wallets/${wallet.id}`}
        className={cn(
          "flex h-full flex-col gap-3 rounded-[18px] border border-border bg-surface p-4 transition-colors sm:p-5",
          "hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-bold text-foreground">{wallet.name}</span>
            <span className="block text-[13px] text-muted-foreground">{entryCountLabel(wallet.transactionCount)}</span>
          </span>
          <BalanceSparkline month={month} />
        </span>
        <span className="flex flex-col gap-1">
          <span
            className={cn(
              "truncate text-[28px] leading-none font-extrabold tracking-[-0.03em] tabular-nums",
              wallet.balanceMinor < 0 ? "text-expense" : "text-foreground",
            )}
          >
            <span className="sr-only">Balance </span>
            {formatMoney(wallet.balanceMinor, wallet.currency)}
          </span>
          <span
            className={cn(
              "text-[13px] font-semibold tabular-nums",
              change > 0 ? "text-income" : change < 0 ? "text-expense" : "font-normal text-muted-foreground",
            )}
          >
            {changeLabel(change, wallet.currency)}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** A currency's heading row (code, name, the total of its active wallets) over the grid of its wallet cards. */
export function WalletGroup({
  currency,
  wallets,
  months,
}: {
  currency: string;
  wallets: WalletView[];
  months: Map<number, WalletCardMonth>;
}) {
  const total = wallets.reduce((sum, w) => sum + w.balanceMinor, 0);
  const headingId = `wallets-${currency}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <h2 id={headingId} className="flex min-w-0 items-baseline gap-2">
          <span className="text-[15px] font-extrabold text-foreground">{currency}</span>
          <span className="truncate text-sm text-muted-foreground">{currencyName(currency)}</span>
        </h2>
        <p className={cn("text-[15px] font-bold tabular-nums", total < 0 ? "text-expense" : "text-foreground")}>
          <span className="sr-only">Total in {currency}: </span>
          {formatMoney(total, currency)}
        </p>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-3">
        {wallets.map((w) => (
          <WalletTile
            key={w.id}
            wallet={w}
            month={months.get(w.id) ?? { openingMinor: w.balanceMinor, changeMinor: 0, closings: [] }}
          />
        ))}
      </ul>
    </section>
  );
}

/** The Archived section: a muted heading over rows (name, currency · entries · hidden…, balance, Unarchive). */
export function ArchivedWallets({ wallets }: { wallets: WalletView[] }) {
  return (
    <section aria-labelledby="wallets-archived" className="flex flex-col gap-3">
      <h2 id="wallets-archived" className="px-1 text-sm font-bold text-muted-foreground">
        Archived
      </h2>
      <ul className="divide-y divide-surface-muted rounded-[18px] border border-border bg-surface">
        {wallets.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
            <div className="min-w-0 flex-1 basis-48">
              <Link
                href={`/wallets/${w.id}`}
                className="block truncate font-semibold text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {w.name}
              </Link>
              <p className="text-xs text-muted-foreground">
                {w.currency} · {w.transactionCount === 0 ? "no entries" : entryCountLabel(w.transactionCount)} · hidden from
                Overview and pickers
              </p>
            </div>
            <span className="ml-auto font-bold text-muted-foreground tabular-nums">
              <span className="sr-only">Balance </span>
              {formatMoney(w.balanceMinor, w.currency)}
            </span>
            <ActionButton
              action={unarchiveWalletAction.bind(null, w.id)}
              label="Unarchive"
              pendingLabel="Unarchiving…"
              buttonClassName="max-sm:h-11!"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
