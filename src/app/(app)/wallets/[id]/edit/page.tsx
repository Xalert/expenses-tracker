import type { Metadata } from "next";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { EditWallet, walletToEdit } from "./edit-wallet";

export const metadata: Metadata = { title: "Edit wallet" };

/** The full page (direct visit, reload, no JS). A link from inside the app opens `@modal/(.)wallets/[id]/edit`. */
export default async function EditWalletPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const wallet = walletToEdit(user.id, (await params).id);

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Edit wallet" description={wallet.name} />
      <Card>
        <CardBody>
          <EditWallet wallet={wallet} />
        </CardBody>
      </Card>
    </div>
  );
}
