import { NEW_WALLET_DESCRIPTION, NewWallet } from "@/app/(app)/wallets/new/new-wallet";
import { Dialog } from "@/components/ui";
import { requireUser } from "@/lib/auth";

/** `/wallets/new` opened from inside the app: the full page's form in a dialog. */
export default async function NewWalletDialog() {
  await requireUser();
  return (
    <Dialog title="New wallet" description={NEW_WALLET_DESCRIPTION}>
      <NewWallet variant="dialog" />
    </Dialog>
  );
}
