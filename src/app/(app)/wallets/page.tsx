import type { Metadata } from "next";
import { PlusIcon, WalletIcon } from "@/components/shell/icons";
import { Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { WalletRow } from "@/components/wallets/wallet-card";
import { requireUser } from "@/lib/auth";
import { listWallets } from "@/server/wallets";

export const metadata: Metadata = { title: "Wallets" };

export default async function WalletsPage() {
  const user = await requireUser();
  const all = listWallets(user.id, { includeArchived: true });
  const active = all.filter((w) => w.archivedAt === null);
  const archived = all.filter((w) => w.archivedAt !== null);

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
        <div className="space-y-6">
          <Card>
            <CardHeader title="Active" description={`${active.length} ${active.length === 1 ? "wallet" : "wallets"}`} />
            {active.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
                All your wallets are archived.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {active.map((w) => (
                  <WalletRow key={w.id} wallet={w} />
                ))}
              </ul>
            )}
          </Card>

          {archived.length > 0 && (
            <Card>
              <CardHeader title="Archived" description="Hidden from the dashboard and pickers; history is kept." />
              <ul className="divide-y divide-border">
                {archived.map((w) => (
                  <WalletRow key={w.id} wallet={w} />
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
