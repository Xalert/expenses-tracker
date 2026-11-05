import Link from "next/link";
import { Amount, Badge } from "@/components/ui";
import { cn } from "@/lib/cn";
import { currencyName } from "@/lib/currencies";
import type { WalletView } from "@/server/wallets";

/** Dashboard tile: wallet name, currency and balance, linking to the wallet page. */
export function WalletCard({ wallet, className }: { wallet: WalletView; className?: string }) {
  return (
    <Link
      href={`/wallets/${wallet.id}`}
      className={cn(
        "group block rounded-xl border border-border bg-surface p-4 shadow-xs transition-colors",
        "hover:border-border-strong hover:bg-surface-muted/50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-foreground group-hover:text-accent">{wallet.name}</p>
        <Badge title={currencyName(wallet.currency)}>{wallet.currency}</Badge>
      </div>
      <p className="mt-3 text-xl font-semibold tracking-tight text-foreground">
        <Amount minor={wallet.balanceMinor} currency={wallet.currency} colorNegative />
      </p>
    </Link>
  );
}

/** One row of the /wallets list. */
export function WalletRow({ wallet }: { wallet: WalletView }) {
  const archived = wallet.archivedAt !== null;
  return (
    <li>
      <Link
        href={`/wallets/${wallet.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={cn("truncate text-sm font-medium", archived ? "text-muted-foreground" : "text-foreground")}>
              {wallet.name}
            </p>
            {archived && <Badge>Archived</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {wallet.currency} · {currencyName(wallet.currency)} · {wallet.transactionCount}{" "}
            {wallet.transactionCount === 1 ? "transaction" : "transactions"}
          </p>
        </div>
        <span className={cn("text-sm font-semibold", archived ? "text-muted-foreground" : "text-foreground")}>
          <Amount minor={wallet.balanceMinor} currency={wallet.currency} colorNegative={!archived} />
        </span>
      </Link>
    </li>
  );
}
