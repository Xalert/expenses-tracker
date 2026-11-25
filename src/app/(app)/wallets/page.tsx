import type { Metadata } from "next";
import { PlusIcon, WalletIcon } from "@/components/shell/icons";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { ArchivedGroups } from "@/components/wallets/archived-groups";
import { GroupDot } from "@/components/wallets/group-dot";
import { GroupsCard } from "@/components/wallets/groups-card";
import { ArchivedWallets, WalletGroup, type WalletCardMonth } from "@/components/wallets/wallet-cards";
import { requireUser } from "@/lib/auth";
import { todayInZone } from "@/lib/dates";
import { getGroupScope } from "@/lib/group-scope";
import { getWalletMonth, listUserCurrencies } from "@/server/insights";
import type { WalletGroupView } from "@/server/wallet-groups";
import { listWallets, type WalletView } from "@/server/wallets";

export const metadata: Metadata = { title: "Wallets" };

export default async function WalletsPage() {
  const user = await requireUser();
  const { groups, archivedGroups, selected } = await getGroupScope();
  const groupId = selected?.id;
  const all = await listWallets(user.id, { includeArchived: true, groupId });
  // Wallets of an archived group are listed with their group under "Archived groups", not with the others.
  const inArchivedGroup = all.filter((w) => w.groupArchived);
  const shown = all.filter((w) => !w.groupArchived);
  const active = shown.filter((w) => w.archivedAt === null);
  const archived = shown.filter((w) => w.archivedAt !== null);
  const today = todayInZone(user.timeZone);
  const month = today.slice(0, 7);

  const months = new Map<number, WalletCardMonth>();
  for (const w of active) {
    const m = await getWalletMonth(user.id, w.id, month, { today });
    if (m) {
      months.set(w.id, {
        openingMinor: m.openingMinor,
        changeMinor: m.inMinor - m.outMinor,
        closings: m.days.map((d) => d.closingMinor),
      });
    }
  }

  const currencies = await listUserCurrencies(user.id, { groupId });
  // With All and two or more groups, the cards sit under one heading per group (the groups come by position).
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

      <div className="mt-8 flex flex-col gap-4">
        <GroupsCard groups={groups.map(({ id, name, walletCount, color }) => ({ id, name, walletCount, color }))} />
        {!selected && <ArchivedGroups groups={archivedGroups} wallets={inArchivedGroup} />}
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
        <h2
          id={`wallets-group-${g.id}`}
          className="flex items-center gap-2 border-b border-border px-1 pb-2 text-lg font-extrabold tracking-tight text-foreground"
        >
          <GroupDot color={g.color} />
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
