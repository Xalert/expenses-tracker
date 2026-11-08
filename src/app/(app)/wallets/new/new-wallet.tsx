import { WalletForm } from "@/components/wallets/wallet-form";
import { CURRENCIES, PINNED_CURRENCIES } from "@/lib/currencies";
import { createWalletAction } from "../actions";

const pinnedSet = new Set<string>(PINNED_CURRENCIES);

/**
 * The "New wallet" form, shared by the full page and the `@modal/(.)wallets/new` dialog (`variant="dialog"`: a save
 * closes the dialog instead of redirecting to the new wallet).
 */
export function NewWallet({ variant = "page" }: { variant?: "page" | "dialog" }) {
  // Built on the server so the option list never differs between server and browser Intl data.
  return (
    <WalletForm
      mode="create"
      variant={variant}
      action={createWalletAction}
      pinned={CURRENCIES.filter((c) => pinnedSet.has(c.code))}
      all={CURRENCIES}
      cancelHref="/wallets"
      submitLabel="Create wallet"
      pendingLabel="Creating…"
    />
  );
}

export const NEW_WALLET_DESCRIPTION = "A bank account, card or cash pocket in one currency.";
