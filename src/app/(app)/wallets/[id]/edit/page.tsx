import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { WalletForm } from "@/components/wallets/wallet-form";
import { requireUser } from "@/lib/auth";
import { currencyName } from "@/lib/currencies";
import { minorToInputValue } from "@/lib/money";
import { getWallet } from "@/server/wallets";
import { updateWalletAction } from "../../actions";
import { parseWalletId } from "../../form-input";

export const metadata: Metadata = { title: "Edit wallet" };

export default async function EditWalletPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const walletId = parseWalletId((await params).id);
  const wallet = walletId ? getWallet(user.id, walletId) : null;
  if (!wallet) notFound();

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Edit wallet" description={wallet.name} />
      <Card>
        <CardBody>
          <WalletForm
            mode="edit"
            action={updateWalletAction.bind(null, wallet.id)}
            currency={wallet.currency}
            currencyLabel={`${wallet.currency} — ${currencyName(wallet.currency)}`}
            defaults={{ name: wallet.name, initialBalance: minorToInputValue(wallet.initialBalanceMinor, wallet.currency) }}
            cancelHref={`/wallets/${wallet.id}`}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardBody>
      </Card>
    </div>
  );
}
