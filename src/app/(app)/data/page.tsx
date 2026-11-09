import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CopyContextButton } from "@/components/data/copy-context-button";
import { ImportPanel } from "@/components/data/import-panel";
import { DownloadIcon } from "@/components/shell/icons";
import { Card, PageHeader, buttonClasses } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getGroupScope } from "@/lib/group-scope";

export const metadata: Metadata = { title: "Import & export" };

export default async function DataPage() {
  await requireUser();
  const { groups, selected } = await getGroupScope();
  // Where an import puts new wallets: the selected group, else the oldest one (the default group).
  const target = selected ?? groups.reduce<(typeof groups)[number] | null>((a, g) => (!a || g.id < a.id ? g : a), null);
  return (
    <>
      <PageHeader
        title="Import & export"
        description="Back up your account, move it to another instance, take your transactions to a spreadsheet and back, or bring them over from Spendee."
      />
      <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-6">
        <section aria-labelledby="export-heading" className="min-w-0">
          <h2 id="export-heading" className="mb-3 text-lg font-extrabold tracking-tight text-foreground">
            Export
          </h2>
          <Card>
            <ul className="divide-y divide-surface-muted">
              <ExportRow
                format="JSON"
                title="Full backup"
                description="Everything in your account — wallets with their initial balances and archived state, categories, transactions and transfers — to keep as a backup or to move the account to another instance."
                action={<DownloadLink href="/api/export/backup" label="Download backup" />}
              />
              <ExportRow
                format="CSV"
                title="Transactions"
                description="Every expense, income and transfer as one spreadsheet row, without initial balances, archived state or unused categories (use the backup to move a whole account, and Export CSV on the Transactions page for a filtered list)."
                action={<DownloadLink href="/api/export/transactions" label="Download CSV" />}
              />
              <ExportRow
                format="JSON"
                title="Wallets & categories"
                description="Just the names and currencies of your wallets and the names and kinds of your categories, without any transactions, to give the Statement Importer (or another companion tool) the context it needs."
                action={
                  <CopyContextButton>
                    <DownloadLink href="/api/export/context" label="Download" />
                  </CopyContextButton>
                }
              />
            </ul>
          </Card>
        </section>
        <ImportPanel groupCount={groups.length} targetGroup={target?.name ?? null} />
      </div>
    </>
  );
}

/** A plain <a download>: route handlers are downloads, not client-side navigations. */
function DownloadLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} download className={buttonClasses({ variant: "secondary" })}>
      <DownloadIcon className="size-4" />
      {label}
    </a>
  );
}

function ExportRow({
  format,
  title,
  description,
  action,
}: {
  format: "JSON" | "CSV";
  title: string;
  description: string;
  /** The download link, or a component that groups it with more actions (and may add a full-width line below). */
  action: ReactNode;
}) {
  return (
    <li className="flex gap-3.5 px-4 py-4 sm:px-[18px]">
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-[10px] font-extrabold tracking-[0.08em] text-muted-foreground"
      >
        {format}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <h3 className="text-[15px] font-bold text-foreground">
            {title}
            <span className="sr-only"> ({format})</span>
          </h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
    </li>
  );
}
