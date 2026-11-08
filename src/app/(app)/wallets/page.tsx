import type { Metadata } from "next";
import { PlusIcon, WalletIcon } from "@/components/shell/icons";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { ArchivedWallets, WalletGroup, type WalletCardMonth } from "@/components/wallets/wallet-cards";
import { requireUser } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { getWalletMonth, listUserCurrencies } from "@/server/insights";
import { listWallets } from "@/server/wallets";

export const metadata: Metadata = { title: "Wallets" };

export default async function WalletsPage() {
  const user = await requireUser();
  const all = listWallets(user.id, { includeArchived: true });
  const active = all.filter((w) => w.archivedAt === null);
  const archived = all.filter((w) => w.archivedAt !== null);
  const month = currentMonth();

  const months = new Map<number, WalletCardMonth>();
  for (const w of active) {
    const m = getWalletMonth(user.id, w.id, month);
    if (m) {
      months.set(w.id, {
        openingMinor: m.openingMinor,
        changeMinor: m.inMinor - m.outMinor,
        closings: m.days.map((d) => d.closingMinor),
      });
    }
  }

  const newButton = (
    <LinkButton href="/wallets/new">
      <PlusIcon className="size-4" />
      New wallet
    </LinkButton>
  );

  return (
    <>
      <PageHeader title="Wallets" description="Accounts, cards and cash, each in its own currency." actions={newButton} />

      {all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WalletIcon className="size-8" />}
            title="No wallets yet"
            description="Create a wallet for each account, card or cash pocket you want to track."
            action={newButton}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          {active.length === 0 ? (
            <Card>
              <p className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
                All your wallets are archived. Unarchive one below or create a new one.
              </p>
            </Card>
          ) : (
            listUserCurrencies(user.id).map((currency) => (
              <WalletGroup
                key={currency}
                currency={currency}
                wallets={active.filter((w) => w.currency === currency)}
                months={months}
              />
            ))
          )}

          {archived.length > 0 && <ArchivedWallets wallets={archived} />}
        </div>
      )}
    </>
  );
}
