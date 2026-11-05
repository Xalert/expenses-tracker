import type { ReactNode } from "react";
import { Amount } from "@/components/ui/amount";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import type { TransactionView } from "@/server/transactions";

/** "Food", "Transfer → Savings", "Transfer ← Cash". */
export function transactionLabel(t: TransactionView): string {
  if (t.kind === "transfer_out") return `Transfer → ${t.counterparty?.walletName ?? "wallet"}`;
  if (t.kind === "transfer_in") return `Transfer ← ${t.counterparty?.walletName ?? "wallet"}`;
  return t.categoryName ?? "Uncategorised";
}

const dot: Record<TransactionView["kind"], string> = {
  income: "bg-income",
  expense: "bg-expense",
  transfer_in: "bg-transfer",
  transfer_out: "bg-transfer",
};

/**
 * Read-only list of transactions. Server-safe (no client JS); the optional `renderActions` render prop
 * adds per-row controls (edit/delete links, a delete form…) on the right of each row.
 */
export function TransactionList({
  items,
  renderActions,
  showWallet = true,
  emptyMessage = "No transactions yet.",
  className,
}: {
  items: TransactionView[];
  renderActions?: (t: TransactionView) => ReactNode;
  /** Hide the wallet name, e.g. on a single wallet's page. */
  showWallet?: boolean;
  emptyMessage?: ReactNode;
  className?: string;
}) {
  if (items.length === 0) {
    return <p className={cn("px-4 py-8 text-center text-sm text-muted-foreground", className)}>{emptyMessage}</p>;
  }

  return (
    <ul className={cn("divide-y divide-border", className)}>
      {items.map((t) => {
        const secondary = [formatDate(t.date), showWallet ? t.walletName : null].filter(Boolean).join(" · ");
        return (
          <li key={t.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <span className={cn("size-2 shrink-0 rounded-full", dot[t.kind])} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-sm font-medium text-foreground">{transactionLabel(t)}</p>
                <Amount
                  minor={t.signedAmountMinor}
                  currency={t.currency}
                  kind={t.kind}
                  signed
                  className="text-sm font-semibold"
                />
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                <p className="min-w-0 truncate">
                  <time dateTime={t.date}>{secondary}</time>
                  {t.note && <span className="text-muted-foreground"> — {t.note}</span>}
                </p>
                {t.counterparty && t.counterparty.currency !== t.currency && (
                  <Amount
                    minor={t.counterparty.amountMinor}
                    currency={t.counterparty.currency}
                    className="shrink-0"
                  />
                )}
              </div>
            </div>
            {renderActions && <div className="flex shrink-0 items-center gap-1">{renderActions(t)}</div>}
          </li>
        );
      })}
    </ul>
  );
}
