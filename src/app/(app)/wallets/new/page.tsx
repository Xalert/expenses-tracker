import type { Metadata } from "next";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { WalletForm } from "@/components/wallets/wallet-form";
import { requireUser } from "@/lib/auth";
import { CURRENCIES, PINNED_CURRENCIES } from "@/lib/currencies";
import { createWalletAction } from "../actions";

export const metadata: Metadata = { title: "New wallet" };

const pinnedSet = new Set<string>(PINNED_CURRENCIES);

export default async function NewWalletPage() {
  await requireUser();
  // Built on the server so the option list never differs between server and browser Intl data.
  const currencies = {
    pinned: CURRENCIES.filter((c) => pinnedSet.has(c.code)),
    rest: CURRENCIES.filter((c) => !pinnedSet.has(c.code)),
  };

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New wallet" description="A bank account, card or cash pocket in one currency." />
      <Card>
        <CardBody>
          <WalletForm
            mode="create"
            action={createWalletAction}
            currencies={currencies}
            cancelHref="/wallets"
            submitLabel="Create wallet"
            pendingLabel="Creating…"
          />
        </CardBody>
      </Card>
    </div>
  );
}
