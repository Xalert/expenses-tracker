import "server-only";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/wallets/action-button";
import { WalletForm } from "@/components/wallets/wallet-form";
import { getGroupScope } from "@/lib/group-scope";
import { currencyName } from "@/lib/currencies";
import { minorToInputValue } from "@/lib/money";
import { getWallet, type WalletView } from "@/server/wallets";
import { archiveWalletAction, deleteWalletAction, unarchiveWalletAction, updateWalletAction } from "../../actions";
import { parseWalletId } from "../../form-input";

/** The user's wallet named by the route's `id`, or the not-found page. */
export async function walletToEdit(userId: number, idParam: string): Promise<WalletView> {
  const walletId = parseWalletId(idParam);
  const wallet = walletId ? await getWallet(userId, walletId) : null;
  if (!wallet) notFound();
  return wallet;
}

export const ARCHIVE_EXPLANATION =
  "An archived wallet is hidden from the Overview and the pickers; its entries stay, and you can unarchive it at any time.";

/** The Archive / Unarchive section of the edit form, plus Delete while the wallet has no entries. */
function ManageWallet({ wallet }: { wallet: WalletView }) {
  const archived = wallet.archivedAt !== null;
  return (
    <section aria-labelledby="wallet-manage" className="space-y-3 rounded-2xl border border-border bg-surface-muted/50 p-4">
      <h3 id="wallet-manage" className="text-sm font-bold text-foreground">
        {archived ? "Archived" : "Archive"}
      </h3>
      <p className="text-sm text-muted-foreground">
        {archived ? "This wallet is archived. Unarchive it to use it for new entries again." : ARCHIVE_EXPLANATION}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        {archived ? (
          <ActionButton action={unarchiveWalletAction.bind(null, wallet.id)} label="Unarchive" pendingLabel="Unarchiving…" />
        ) : (
          <ActionButton
            action={archiveWalletAction.bind(null, wallet.id)}
            label="Archive"
            pendingLabel="Archiving…"
            confirmMessage={`Archive “${wallet.name}”? It will be hidden from the Overview and pickers; its history stays.`}
          />
        )}
        {wallet.transactionCount === 0 && (
          <ActionButton
            action={deleteWalletAction.bind(null, wallet.id)}
            label="Delete wallet"
            pendingLabel="Deleting…"
            variant="ghost"
            buttonClassName="text-danger! hover:bg-danger-soft!"
            confirmMessage={`Delete “${wallet.name}”? This can't be undone.`}
          />
        )}
      </div>
    </section>
  );
}

/**
 * The "Edit wallet" form, shared by the full page and the `@modal/(.)wallets/[id]/edit` dialog (`variant="dialog"`:
 * a save closes the dialog instead of redirecting to the wallet).
 */
export async function EditWallet({ wallet, variant = "page" }: { wallet: WalletView; variant?: "page" | "dialog" }) {
  const { groups } = await getGroupScope();
  return (
    <WalletForm
      mode="edit"
      variant={variant}
      action={updateWalletAction.bind(null, wallet.id)}
      currency={wallet.currency}
      currencyLabel={`${wallet.currency} · ${currencyName(wallet.currency)}`}
      groups={groups.map(({ id, name }) => ({ id, name }))}
      defaults={{
        name: wallet.name,
        initialBalance: minorToInputValue(wallet.initialBalanceMinor, wallet.currency),
        groupId: String(wallet.groupId),
      }}
      cancelHref={`/wallets/${wallet.id}`}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      manage={<ManageWallet wallet={wallet} />}
    />
  );
}
