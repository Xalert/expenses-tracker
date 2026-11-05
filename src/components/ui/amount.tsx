import type { TransactionKind } from "@/db/schema";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/money";

const kindColor: Record<TransactionKind, string> = {
  income: "text-income",
  expense: "text-expense",
  transfer_in: "text-transfer",
  transfer_out: "text-transfer",
};

/**
 * Money with `tabular-nums`. With `kind`, the amount is coloured (income emerald, expense rose,
 * transfers sky) and `signed` shows +/-. Without `kind`, negative values are rose when `colorNegative`.
 */
export function Amount({
  minor,
  currency,
  kind,
  signed,
  colorNegative,
  className,
}: {
  minor: number;
  currency: string;
  kind?: TransactionKind;
  signed?: boolean;
  colorNegative?: boolean;
  className?: string;
}) {
  const color = kind ? kindColor[kind] : colorNegative && minor < 0 ? "text-expense" : undefined;
  return (
    <span className={cn("tabular-nums whitespace-nowrap", color, className)}>
      {formatMoney(minor, currency, { signed })}
    </span>
  );
}
