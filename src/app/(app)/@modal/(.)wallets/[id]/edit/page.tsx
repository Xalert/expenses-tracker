import { EditWallet, walletToEdit } from "@/app/(app)/wallets/[id]/edit/edit-wallet";
import { Dialog } from "@/components/ui";
import { requireUser } from "@/lib/auth";

/** `/wallets/<id>/edit` opened from inside the app: the full page's form in a dialog. */
export default async function EditWalletDialog({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const wallet = walletToEdit(user.id, (await params).id);
  return (
    <Dialog title="Edit wallet" description={wallet.name}>
      <EditWallet wallet={wallet} />
    </Dialog>
  );
}
