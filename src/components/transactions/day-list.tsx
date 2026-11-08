import Link from "next/link";
import { transactionLabel } from "@/components/transaction-list";
import { ExpandableList, ExpandableRow } from "@/components/ui/expandable-row";
import { cn } from "@/lib/cn";
import { dayHeaderLabel, dayNetLabel, groupByDate } from "@/lib/day-labels";
import { formatMoney, minorToInputValue } from "@/lib/money";
import { withReturnTo } from "@/lib/return-to";
import type { DayTotal, TransactionView } from "@/server/transactions";
import { InlineEditPanel, type InlineEntry } from "./inline-edit";

const dotClass: Record<TransactionView["kind"], string> = {
  income: "bg-income",
  expense: "bg-expense-dot",
  transfer_in: "bg-transfer",
  transfer_out: "bg-transfer",
};

/** UI direction → Amounts: income green, expenses in the text colour (the dot carries the kind), transfers muted. */
const amountClass: Record<TransactionView["kind"], string> = {
  income: "text-income",
  expense: "text-foreground",
  transfer_in: "text-transfer",
  transfer_out: "text-transfer",
};

/** The editor's starting values for a row. A transfer leg is turned back into its transfer (from → to). */
export function inlineEntryOf(t: TransactionView): InlineEntry {
  const note = t.note ?? "";
  if (t.transferId !== null && t.counterparty) {
    const self = { walletId: t.walletId, currency: t.currency, amountMinor: t.amountMinor };
    const other = t.counterparty;
    const [from, to] = t.kind === "transfer_out" ? [self, other] : [other, self];
    return {
      type: "transfer",
      transferId: t.transferId,
      fromWalletId: from.walletId,
      toWalletId: to.walletId,
      amount: minorToInputValue(from.amountMinor, from.currency),
      receivedAmount: from.currency !== to.currency ? minorToInputValue(to.amountMinor, to.currency) : undefined,
      date: t.date,
      note,
    };
  }
  return {
    type: "transaction",
    id: t.id,
    kind: t.kind === "income" ? "income" : "expense",
    walletId: t.walletId,
    categoryId: t.categoryId ?? undefined,
    amount: minorToInputValue(t.amountMinor, t.currency),
    date: t.date,
    note,
  };
}

function editHref(t: TransactionView): string {
  return t.transferId !== null ? `/transactions/transfers/${t.transferId}/edit` : `/transactions/${t.id}/edit`;
}

/**
 * The row's content inside its button: dot, label, "note · wallet", signed amount (+ the other leg's, muted). A
 * wallet's own page leaves the wallet name out (`showWallet={false}`).
 */
function RowSummary({ t, showWallet }: { t: TransactionView; showWallet: boolean }) {
  const meta = [t.note, showWallet ? t.walletName : null].filter(Boolean).join(" · ");
  const cross = t.counterparty && t.counterparty.currency !== t.currency ? t.counterparty : null;
  return (
    <>
      <span className={cn("size-2 shrink-0 rounded-full", dotClass[t.kind])} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-foreground">{transactionLabel(t)}</span>
        {meta && <span className="block truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className={cn("block font-bold", amountClass[t.kind])}>
          {formatMoney(t.signedAmountMinor, t.currency, { signed: true })}
        </span>
        {cross && (
          <span className="block text-xs text-muted-foreground">
            <span className="sr-only">{t.kind === "transfer_out" ? "received " : "sent "}</span>
            {formatMoney(cross.amountMinor, cross.currency)}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * The /transactions list: the page's entries grouped by day (newest first), each day a card with its header ("Today ·
 * Sunday 8") and the day's net per currency over every match of the filters (`totals`, from `listDayTotals`). Each
 * row opens in place into the inline editor; one open row at a time across the whole list.
 *
 * The wallet page reuses it with `aside` (its "Balance after €…" line replaces the net) and `showWallet={false}`.
 */
export function DayList({
  items,
  totals = [],
  today,
  returnTo,
  aside,
  showWallet = true,
}: {
  items: TransactionView[];
  totals?: DayTotal[];
  today: string;
  /** The list URL (the "Open as page" link's `returnTo`). */
  returnTo: string;
  /** Replaces the day's net on the right of each day header (null = nothing there). */
  aside?: (date: string) => React.ReactNode;
  /** False on a wallet's own page: the rows' meta line leaves the wallet name out. */
  showWallet?: boolean;
}) {
  const netByDate = new Map<string, DayTotal[]>();
  for (const t of totals) netByDate.set(t.date, [...(netByDate.get(t.date) ?? []), t]);
  const defaultAside = (date: string) => {
    const net = netByDate.get(date) ?? [];
    return net.length > 0 ? (
      <>
        <span className="sr-only">Net for the day: </span>
        {dayNetLabel(net)}
      </>
    ) : null;
  };

  return (
    <ExpandableList>
      <div className="flex flex-col gap-3">
        {groupByDate(items).map((group) => {
          const headingId = `day-${group.date}`;
          const right = (aside ?? defaultAside)(group.date);
          return (
            <section key={group.date} aria-labelledby={headingId} className="rounded-[18px] border border-border bg-surface">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 pt-3.5 pb-2.5 sm:px-[18px]">
                <h2 id={headingId} className="text-[13px] font-bold text-foreground">
                  <time dateTime={group.date}>{dayHeaderLabel(group.date, today)}</time>
                </h2>
                {right && <p className="text-[13px] font-semibold text-muted-foreground tabular-nums">{right}</p>}
              </div>
              <ul className="divide-y divide-surface-muted border-t border-surface-muted">
                {group.items.map((t) => {
                  const label = transactionLabel(t);
                  const amount = formatMoney(t.signedAmountMinor, t.currency, { signed: true });
                  return (
                    <ExpandableRow
                      key={t.id}
                      id={String(t.id)}
                      className="last:rounded-b-[18px]"
                      buttonClassName="min-h-11 px-4 py-3 text-sm sm:px-[18px] [li:last-child>&]:rounded-b-[18px]"
                      summary={<RowSummary key="summary" t={t} showWallet={showWallet} />}
                      panelLabel={`Edit ${label}, ${amount}`}
                      panel={<InlineEditPanel key="panel" entry={inlineEntryOf(t)} rowKey={String(t.id)} />}
                      after={
                        // Without JavaScript the row button does nothing: offer the edit page instead.
                        <noscript key="noscript">
                          <Link
                            href={withReturnTo(editHref(t), returnTo)}
                            className="block px-4 pb-3 text-xs font-semibold text-accent-hover hover:underline sm:px-[18px]"
                          >
                            Edit {label}
                          </Link>
                        </noscript>
                      }
                    />
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </ExpandableList>
  );
}
