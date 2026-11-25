import Link from "next/link";
import { deleteGroupAction, moveGroupAction, unarchiveGroupAction } from "@/app/(app)/wallets/actions";
import { formatMoney } from "@/lib/money";
import { entryCountLabel } from "@/lib/wallet-chart";
import type { WalletGroupView } from "@/server/wallet-groups";
import type { WalletWithBalance } from "@/server/wallets";
import { ActionButton } from "./action-button";
import { GroupDot } from "./group-dot";
import { ArchivedGroupEditor } from "./groups-card";
import { projectedLabel } from "./wallet-cards";

const walletsLabel = (n: number) => (n === 1 ? "1 wallet" : `${n} wallets`);

/**
 * The Wallets page's "Archived groups" section (with All selected): a closed `<details>` with each archived group in
 * its order, its wallets (links, balances), Edit (rename / recolour in place, without unarchiving; needs JavaScript)
 * and Unarchive — plus Delete while it is empty. The rest works without JavaScript apart from the confirm on Delete.
 */
export function ArchivedGroups({ groups, wallets }: { groups: WalletGroupView[]; wallets: WalletWithBalance[] }) {
  if (groups.length === 0) return null;
  return (
    <details className="group/archived rounded-[18px] border border-border bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-bold text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-5 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="transition-transform group-open/archived:rotate-90">
          ›
        </span>
        Archived groups · {groups.length}
      </summary>
      <ul className="divide-y divide-surface-muted border-t border-surface-muted">
        {groups.map((g, i) => {
          const own = wallets.filter((w) => w.groupId === g.id);
          return (
            <li key={g.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <GroupDot color={g.color} />
                <h3 className="min-w-0 flex-1 basis-32 truncate font-bold text-foreground">{g.name}</h3>
                <span className="text-[13px] text-muted-foreground">{walletsLabel(g.walletCount)}</span>
                {groups.length > 1 && (
                  <span className="flex gap-1">
                    <form action={moveGroupAction.bind(null, g.id, "up")}>
                      <button
                        type="submit"
                        disabled={i === 0}
                        aria-label={`Move ${g.name} up`}
                        className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-surface-muted disabled:opacity-30"
                      >
                        <span aria-hidden="true">↑</span>
                      </button>
                    </form>
                    <form action={moveGroupAction.bind(null, g.id, "down")}>
                      <button
                        type="submit"
                        disabled={i === groups.length - 1}
                        aria-label={`Move ${g.name} down`}
                        className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-surface-muted disabled:opacity-30"
                      >
                        <span aria-hidden="true">↓</span>
                      </button>
                    </form>
                  </span>
                )}
                <ArchivedGroupEditor group={{ id: g.id, name: g.name, walletCount: g.walletCount, color: g.color }} />
                <ActionButton
                  action={unarchiveGroupAction.bind(null, g.id)}
                  label="Unarchive"
                  pendingLabel="Unarchiving…"
                  buttonClassName="max-sm:h-11!"
                />
                {g.walletCount === 0 && (
                  <ActionButton
                    action={deleteGroupAction.bind(null, g.id)}
                    label="Delete"
                    pendingLabel="Deleting…"
                    variant="ghost"
                    confirmMessage={`Delete the group “${g.name}”? It has no wallets.`}
                    buttonClassName="text-danger! hover:bg-danger-soft! max-sm:h-11!"
                  />
                )}
              </div>
              {own.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {own.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center gap-x-3 text-sm">
                      <Link
                        href={`/wallets/${w.id}`}
                        className="min-w-0 flex-1 truncate font-semibold text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {w.name}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {w.currency} · {w.transactionCount === 0 ? "no entries" : entryCountLabel(w.transactionCount)}
                        {w.archivedAt !== null && " · archived"}
                        {projectedLabel(w) && ` · ${projectedLabel(w)}`}
                      </span>
                      <span className="font-bold text-muted-foreground tabular-nums">
                        <span className="sr-only">Balance </span>
                        {formatMoney(w.balanceMinor, w.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
