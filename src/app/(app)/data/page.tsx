import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CopyContextButton } from "@/components/data/copy-context-button";
import { ImportPanel } from "@/components/data/import-panel";
import { DownloadIcon } from "@/components/shell/icons";
import { Card, CardHeader, buttonClasses } from "@/components/ui";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Import & export" };

export default async function DataPage() {
  await requireUser();
  return (
    <>
      <PageHeader
        title="Import & export"
        description="Back up your account, move it to another instance, take your transactions to a spreadsheet and back, or bring them over from Spendee."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader title="Export" description="Downloads are generated from your current data." />
          <ul className="divide-y divide-border">
            <ExportRow
              href="/api/export/backup"
              title="Full backup (JSON)"
              label="Download backup"
              description="Everything in your account: wallets with their initial balances and archived state, categories, transactions and transfers. Use it to keep a backup or to move your account to another instance."
            />
            <ExportRow
              href="/api/export/transactions"
              title="Transactions (CSV)"
              label="Download CSV"
              description="Every expense, income and transfer as one spreadsheet row. It has no initial balances, archived state or unused categories, so use the backup to move a whole account. To export a filtered list, use Export CSV on the Transactions page."
            />
            <ExportRow
              href="/api/export/context"
              title="Wallets & categories (JSON)"
              label="Download"
              description="Just the names and currencies of your wallets and the names and kinds of your categories, without any transactions, to give the Statement Importer (or another companion tool) the context it needs."
            >
              <CopyContextButton />
            </ExportRow>
          </ul>
        </Card>
        <ImportPanel />
      </div>
    </>
  );
}

function ExportRow({
  href,
  title,
  label,
  description,
  children,
}: {
  href: string;
  title: string;
  label: string;
  description: string;
  /** Extra actions next to the download button. */
  children?: ReactNode;
}) {
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {/* A plain <a>: route handlers are downloads, not client-side navigations. */}
        <a href={href} download className={buttonClasses({ variant: "secondary", size: "sm" })}>
          <DownloadIcon className="size-4" />
          {label}
        </a>
        {children}
      </div>
    </li>
  );
}
