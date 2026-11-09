import Link from "next/link";
import { transactionLabel } from "@/components/transaction-list";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/money";
import { shortDateLabel } from "@/lib/overview";
import type { TransactionView } from "@/server/transactions";
import type { WalletView } from "@/server/wallets";

const cardClass = "min-w-0 rounded-[18px] border border-border bg-surface py-2";
const rowClass = "flex min-h-11 items-center gap-3 border-t border-surface-muted px-4 py-3 text-sm sm:px-5";

/** The total line at the top of the Wallets card. */
export type WalletsTotal = {
  currency: string;
  totalMinor: number;
  /** Shown under the total: the rate date and source, or why some wallets are left out. */
  notes: string[];
  /** True when the total includes converted amounts (it is then shown with "≈"). */
  approximate: boolean;
};

/** The "All in EUR · EUR only" links of the Wallets card (the view lives in the URL, `?view=only`). */
export function WalletsViewSwitch({
  options,
}: {
  options: { label: string; href: string; current: boolean }[];
}) {
  return (
    <nav aria-label="Wallets shown" className="max-w-full overflow-x-auto">
      <ul className="inline-flex gap-1 rounded-full bg-surface-muted p-1">
        {options.map((o) => (
          <li key={o.href} className="flex">
            <Link
              href={o.href}
              scroll={false}
              aria-current={o.current ? "true" : undefined}
              className={cn(
                "flex h-8 items-center justify-center rounded-full px-3 text-xs font-semibold whitespace-nowrap transition-colors",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                o.current ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Active wallets: name, the month's change (in − out, transfers included) and the balance. With `total`, a total
 * line comes first; with `converted`, a wallet in another currency also shows its balance in `total.currency`.
 */
export function WalletsCard({
  wallets,
  changes,
  hrefFor,
  changeLabel,
  total,
  converted,
  viewSwitch,
}: {
  wallets: WalletView[];
  /** Month change per wallet id. */
  changes: Map<number, number>;
  hrefFor(walletId: number): string;
  /** "this month" / "in October": read after each change for screen readers. */
  changeLabel: string;
  total?: WalletsTotal;
  /** Balance in `total.currency` per wallet id, for wallets in another currency. */
  converted?: Map<number, number>;
  viewSwitch?: React.ReactNode;
}) {
  return (
    <section aria-labelledby="overview-wallets" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
        <h2 id="overview-wallets" className="text-[15px] font-bold text-foreground">
          Wallets
        </h2>
        <div className="flex min-w-0 items-center gap-3">
          {viewSwitch}
          <Link href="/wallets" className="text-[13px] font-semibold text-accent-hover hover:underline">
            Manage
          </Link>
        </div>
      </div>
      {total && (
        <div className="border-t border-surface-muted px-4 py-3 sm:px-5">
          <p className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold text-muted-foreground">Total in {total.currency}</span>
            <span
              className={cn(
                "text-lg font-extrabold tabular-nums",
                total.totalMinor < 0 ? "text-expense" : "text-foreground",
              )}
            >
              {total.approximate && (
                <>
                  <span aria-hidden="true">≈ </span>
                  <span className="sr-only">about </span>
                </>
              )}
              {formatMoney(total.totalMinor, total.currency)}
            </span>
          </p>
          {total.notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-muted-foreground">
              {n}
            </p>
          ))}
        </div>
      )}
      {wallets.length === 0 ? (
        <p className="border-t border-surface-muted px-4 py-6 text-sm text-muted-foreground sm:px-5">
          No active wallets in this currency.
        </p>
      ) : (
        <ul>
          {wallets.map((w) => {
            const change = changes.get(w.id) ?? 0;
            const equivalent = total ? converted?.get(w.id) : undefined;
            return (
              <li key={w.id}>
                <Link
                  href={hrefFor(w.id)}
                  className={cn(
                    rowClass,
                    "transition-colors hover:bg-surface-open focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{w.name}</span>
                  <span
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      change > 0 ? "text-income" : change < 0 ? "text-expense" : "text-muted-foreground",
                    )}
                  >
                    {change === 0 ? "no change" : formatMoney(change, w.currency, { signed: true })}
                    <span className="sr-only"> {changeLabel}</span>
                  </span>
                  <span className="w-28 shrink-0 text-right sm:w-32">
                    <span
                      className={cn(
                        "block font-bold tabular-nums",
                        w.balanceMinor < 0 ? "text-expense" : "text-foreground",
                      )}
                    >
                      <span className="sr-only">, balance </span>
                      {formatMoney(w.balanceMinor, w.currency)}
                    </span>
                    {equivalent !== undefined && total && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        <span className="sr-only">, about </span>
                        <span aria-hidden="true">≈ </span>
                        {formatMoney(equivalent, total.currency)}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const dotClass: Record<TransactionView["kind"], string> = {
  income: "bg-income",
  expense: "bg-expense-dot",
  transfer_in: "bg-transfer",
  transfer_out: "bg-transfer",
};

const amountClass: Record<TransactionView["kind"], string> = {
  income: "text-income",
  expense: "text-foreground",
  transfer_in: "text-transfer",
  transfer_out: "text-transfer",
};

/** The latest entries of every wallet, with a link to Transactions. */
export function LatestCard({ items, today }: { items: TransactionView[]; today: string }) {
  return (
    <section aria-labelledby="overview-latest" className={cardClass}>
      <div className="flex items-baseline justify-between gap-3 px-4 py-3 sm:px-5">
        <h2 id="overview-latest" className="text-[15px] font-bold text-foreground">
          Latest
        </h2>
        <Link href="/transactions" className="text-[13px] font-semibold text-accent-hover hover:underline">
          All transactions
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="border-t border-surface-muted px-4 py-6 text-sm text-muted-foreground sm:px-5">
          No transactions yet.
        </p>
      ) : (
        <ul>
          {items.map((t) => (
            <li key={t.id} className={rowClass}>
              <span className={cn("size-2 shrink-0 rounded-full", dotClass[t.kind])} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-foreground">{transactionLabel(t)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  <time dateTime={t.date}>{shortDateLabel(t.date, today)}</time>
                  {t.note && <> · {t.note}</>} · {t.walletName}
                </span>
              </span>
              <span className={cn("shrink-0 font-bold tabular-nums", amountClass[t.kind])}>
                {formatMoney(t.signedAmountMinor, t.currency, { signed: true })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
