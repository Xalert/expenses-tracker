import { WalletForm } from "@/components/wallets/wallet-form";
import { CURRENCIES, PINNED_CURRENCIES } from "@/lib/currencies";
import { createWalletAction } from "../actions";

const pinnedSet = new Set<string>(PINNED_CURRENCIES);

/** The "New wallet" form, shared by the full page and the `@modal/(.)wallets/new` dialog. */
export function NewWallet() {
  // Built on the server so the option list never differs between server and browser Intl data.
  const currencies = {
    pinned: CURRENCIES.filter((c) => pinnedSet.has(c.code)),
    rest: CURRENCIES.filter((c) => !pinnedSet.has(c.code)),
  };
  return (
    <WalletForm
      mode="create"
      action={createWalletAction}
      currencies={currencies}
      cancelHref="/wallets"
      submitLabel="Create wallet"
      pendingLabel="Creating…"
    />
  );
}

export const NEW_WALLET_DESCRIPTION = "A bank account, card or cash pocket in one currency.";
