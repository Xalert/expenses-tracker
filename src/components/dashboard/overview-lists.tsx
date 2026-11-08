import Link from "next/link";
import { transactionLabel } from "@/components/transaction-list";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/money";
import { shortDateLabel } from "@/lib/overview";
import type { TransactionView } from "@/server/transactions";
import type { WalletView } from "@/server/wallets";

const cardClass = "min-w-0 rounded-[18px] border border-border bg-surface py-2";
const rowClass = "flex min-h-11 items-center gap-3 border-t border-surface-muted px-4 py-3 text-sm sm:px-5";

/** Active wallets of every currency: name, the month's change (in − out, transfers included) and the balance. */
export function WalletsCard({
  wallets,
  changes,
  hrefFor,
  changeLabel,
}: {
  wallets: WalletView[];
  /** Month change per wallet id. */
  changes: Map<number, number>;
  hrefFor(walletId: number): string;
  /** "this month" / "in October": read after each change for screen readers. */
  changeLabel: string;
}) {
  return (
    <section aria-labelledby="overview-wallets" className={cardClass}>
      <div className="flex items-baseline justify-between gap-3 px-4 py-3 sm:px-5">
        <h2 id="overview-wallets" className="text-[15px] font-bold text-foreground">
          Wallets
        </h2>
        <Link href="/wallets" className="text-[13px] font-semibold text-accent-hover hover:underline">
          Manage
        </Link>
      </div>
      <ul>
        {wallets.map((w) => {
          const change = changes.get(w.id) ?? 0;
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
                <span
                  className={cn(
                    "w-28 shrink-0 text-right font-bold tabular-nums sm:w-32",
                    w.balanceMinor < 0 ? "text-expense" : "text-foreground",
                  )}
                >
                  <span className="sr-only">, balance </span>
                  {formatMoney(w.balanceMinor, w.currency)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
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
