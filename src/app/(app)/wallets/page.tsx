import type { Metadata } from "next";
import { PlusIcon, WalletIcon } from "@/components/shell/icons";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { GroupsCard } from "@/components/wallets/groups-card";
import { ArchivedWallets, WalletGroup, type WalletCardMonth } from "@/components/wallets/wallet-cards";
import { requireUser } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { getGroupScope } from "@/lib/group-scope";
import { getWalletMonth, listUserCurrencies } from "@/server/insights";
import type { WalletGroupView } from "@/server/wallet-groups";
import { listWallets, type WalletView } from "@/server/wallets";

export const metadata: Metadata = { title: "Wallets" };

export default async function WalletsPage() {
  const user = await requireUser();
  const { groups, selected } = await getGroupScope();
  const groupId = selected?.id;
  const all = listWallets(user.id, { includeArchived: true, groupId });
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

  const currencies = listUserCurrencies(user.id, { groupId });
  // With All and two or more groups, the cards sit under one heading per group (the groups come by name).
  const byGroup = !selected && groups.length >= 2;

  const newButton = (
    <LinkButton href="/wallets/new">
      <PlusIcon className="size-4" />
      New wallet
    </LinkButton>
  );

  return (
    <>
      <PageHeader title="Wallets" description={
          selected
            ? `Accounts, cards and cash in ${selected.name}, each in its own currency.`
            : "Accounts, cards and cash, each in its own currency."
        } actions={newButton} />

      {all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<WalletIcon className="size-8" />}
            title={selected ? `No wallets in ${selected.name} yet` : "No wallets yet"}
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
            <CurrencySections wallets={active} currencies={currencies} months={months} groups={byGroup ? groups : null} />
          )}

          {archived.length > 0 && <ArchivedWallets wallets={archived} />}
        </div>
      )}

      <div className="mt-8">
        <GroupsCard groups={groups.map(({ id, name, walletCount }) => ({ id, name, walletCount }))} />
      </div>
    </>
  );
}

/** The active wallets by currency; with `groups` (All, two or more groups) one heading per group first. */
function CurrencySections({
  wallets,
  currencies,
  months,
  groups,
}: {
  wallets: WalletView[];
  currencies: string[];
  months: Map<number, WalletCardMonth>;
  groups: WalletGroupView[] | null;
}) {
  if (!groups) {
    return currencies.map((currency) => (
      <WalletGroup
        key={currency}
        currency={currency}
        wallets={wallets.filter((w) => w.currency === currency)}
        months={months}
      />
    ));
  }
  return groups.map((g) => {
    const own = wallets.filter((w) => w.groupId === g.id);
    return (
      <section key={g.id} aria-labelledby={`wallets-group-${g.id}`} className="flex flex-col gap-5">
        <h2 id={`wallets-group-${g.id}`} className="border-b border-border px-1 pb-2 text-lg font-extrabold tracking-tight text-foreground">
          {g.name}
        </h2>
        {own.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No active wallets in this group.</p>
        ) : (
          currencies
            .filter((c) => own.some((w) => w.currency === c))
            .map((currency) => (
              <WalletGroup
                key={currency}
                as="h3"
                idPrefix={`g${g.id}-`}
                currency={currency}
                wallets={own.filter((w) => w.currency === currency)}
                months={months}
              />
            ))
        )}
      </section>
    );
  });
}
