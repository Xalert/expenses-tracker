import type { Metadata } from "next";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { NEW_WALLET_DESCRIPTION, NewWallet } from "./new-wallet";

export const metadata: Metadata = { title: "New wallet" };

/** The full page (direct visit, reload, no JS). A link from inside the app opens `@modal/(.)wallets/new`. */
export default async function NewWalletPage() {
  await requireUser();
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New wallet" description={NEW_WALLET_DESCRIPTION} />
      <Card>
        <CardBody>
          <NewWallet />
        </CardBody>
      </Card>
    </div>
  );
}
