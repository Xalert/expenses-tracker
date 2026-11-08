import "server-only";
import { notFound } from "next/navigation";
import { WalletForm } from "@/components/wallets/wallet-form";
import { currencyName } from "@/lib/currencies";
import { minorToInputValue } from "@/lib/money";
import { getWallet, type WalletView } from "@/server/wallets";
import { updateWalletAction } from "../../actions";
import { parseWalletId } from "../../form-input";

/** The user's wallet named by the route's `id`, or the not-found page. */
export function walletToEdit(userId: number, idParam: string): WalletView {
  const walletId = parseWalletId(idParam);
  const wallet = walletId ? getWallet(userId, walletId) : null;
  if (!wallet) notFound();
  return wallet;
}

/** The "Edit wallet" form, shared by the full page and the `@modal/(.)wallets/[id]/edit` dialog. */
export function EditWallet({ wallet }: { wallet: WalletView }) {
  return (
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
  );
}
