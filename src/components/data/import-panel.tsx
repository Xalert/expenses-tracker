"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { previewImportAction, runImportAction, type ImportActionState } from "@/app/(app)/data/actions";
import { Badge, Button, Card, CardHeader, FormError, Label, buttonClasses } from "@/components/ui";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "@/lib/constants";
import type { ImportNotice, ImportPreview, ImportProblem } from "@/server/import";

const MB = IMPORT_MAX_BYTES / 1024 / 1024;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Two-step import: the chosen File stays in state, and each step uploads it again with a fresh FormData (the
 * server re-validates on confirm; a preview is never trusted). Changing the file or the checkbox discards the
 * preview, so what is confirmed is always what was previewed.
 */
export function ImportPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [state, setState] = useState<ImportActionState | null>(null);
  const [step, setStep] = useState<"preview" | "import" | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Move focus to the outcome so screen readers read it and keyboard users land next to the next action.
  useEffect(() => {
    if (state) resultRef.current?.focus();
  }, [state]);

  function reset(next: { file?: File | null; skip?: boolean }) {
    if (next.file !== undefined) setFile(next.file);
    if (next.skip !== undefined) setSkipDuplicates(next.skip);
    setState(null);
  }

  function submit(kind: "preview" | "import") {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setState({ error: `The file is larger than ${MB} MB. Split it into smaller files and import them one by one.` });
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("skipDuplicates", skipDuplicates ? "on" : "off");
    setStep(kind);
    startTransition(async () => {
      try {
        const next = await (kind === "preview" ? previewImportAction(fd) : runImportAction(fd));
        setState(next);
        if (next.result?.imported) {
          setFile(null);
          if (inputRef.current) inputRef.current.value = "";
        }
      } catch {
        setState({ error: "The upload failed. Check your connection (and any proxy upload limit) and try again." });
      }
    });
  }

  const preview = state?.result ?? state?.preview;
  const imported = state?.result?.imported === true;
  const tooBig = file !== null && file.size > IMPORT_MAX_BYTES;

  return (
    <Card>
      <CardHeader
        title="Import"
        description="Adds a backup, a transactions CSV or a Spendee export to this account. Nothing is changed or deleted, and nothing is saved until you confirm."
      />
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="space-y-1.5">
          <Label htmlFor="import-file">File</Label>
          <input
            ref={inputRef}
            id="import-file"
            name="file"
            type="file"
            accept=".json,.csv,.tsv,.txt,application/json,text/csv,text/tab-separated-values,text/plain"
            aria-describedby="import-file-hint"
            aria-invalid={tooBig || undefined}
            onChange={(e) => reset({ file: e.currentTarget.files?.[0] ?? null })}
            className="block w-full min-w-0 text-sm text-muted-foreground file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <p id="import-file-hint" className="text-xs text-muted-foreground">
            An Expenses Tracker backup (.json) or a transactions CSV (comma, semicolon or tab separated), up to {MB} MB
            and {IMPORT_MAX_ROWS.toLocaleString("en-US")} rows.
          </p>
          <p className="text-xs text-muted-foreground">
            Leaving Spendee? Its CSV export works too: expenses and income are imported with their date (the time is
            dropped), amounts are rounded to the currency&rsquo;s decimals, and missing wallets (starting at a balance
            of 0) and categories are created. Transfers are not supported.
          </p>
        </div>

        <div className="flex items-start gap-3">
          <input
            id="skip-duplicates"
            type="checkbox"
            checked={skipDuplicates}
            onChange={(e) => reset({ skip: e.currentTarget.checked })}
            aria-describedby="skip-duplicates-hint"
            className="mt-0.5 size-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <div>
            <label htmlFor="skip-duplicates" className="text-sm font-medium text-foreground">
              Skip transactions that already exist
            </label>
            <p id="skip-duplicates-hint" className="text-xs text-muted-foreground">
              Same wallet, type, category, date, amount and note (transfers: both wallets, date, both amounts and note).
              Matched one for one: if the file has 3 identical entries and your account has 1, 2 are added.
            </p>
          </div>
        </div>

        <Button
          variant={preview?.ok && !imported ? "secondary" : "primary"}
          onClick={() => submit("preview")}
          disabled={!file || pending}
          pending={pending && step === "preview"}
        >
          {pending && step === "preview" ? "Checking file…" : "Preview import"}
        </Button>

        <div ref={resultRef} tabIndex={-1} aria-live="polite" className="rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-ring">
          {state?.error && <FormError message={state.error} />}
          {imported && state?.result && <ImportSuccess result={state.result} fileName={state.fileName} />}
          {!imported && preview && (
            <PreviewSummary
              preview={preview}
              fileName={state?.fileName}
              confirm={
                preview.ok && preview.transactionsToAdd + preview.transfersToAdd + preview.walletsToCreate.length + preview.categoriesToCreate.length > 0 ? (
                  <Button onClick={() => submit("import")} disabled={pending} pending={pending && step === "import"}>
                    {pending && step === "import" ? "Importing…" : importLabel(preview)}
                  </Button>
                ) : null
              }
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function importLabel(p: ImportPreview): string {
  const n = p.transactionsToAdd + p.transfersToAdd;
  return n > 0 ? `Import ${plural(n, "entry", "entries")}` : "Import";
}

function PreviewSummary({
  preview: p,
  fileName,
  confirm,
}: {
  preview: ImportPreview;
  fileName?: string;
  confirm: React.ReactNode;
}) {
  const formatLabel = p.formatLabel;
  if (!p.ok) {
    return (
      <div className="space-y-3 rounded-lg border border-danger/30 bg-danger-soft/50 p-3 sm:p-4">
        <div role="alert">
          <h3 className="text-sm font-semibold text-danger">
            {plural(p.problemCount, "problem", "problems")} found — nothing can be imported
          </h3>
          <p className="mt-1 text-sm text-foreground">
            {fileName && <span className="font-medium break-all">{fileName}</span>}
            {fileName && formatLabel && " · "}
            {formatLabel}. Fix the file and preview it again.
          </p>
        </div>
        <ProblemList problems={p.problems} />
        <NoticeList notices={p.notices} />
        {p.problemCount > p.problems.length && (
          <p className="text-xs text-muted-foreground">
            Showing the first {p.problems.length} of {p.problemCount.toLocaleString("en-US")} problems.
          </p>
        )}
      </div>
    );
  }

  const duplicates = p.duplicateTransactions + p.duplicateTransfers;
  const nothing = p.transactionsToAdd + p.transfersToAdd + p.walletsToCreate.length + p.categoriesToCreate.length === 0;
  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-muted/60 p-3 sm:p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Ready to import</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {fileName && <span className="font-medium break-all text-foreground">{fileName}</span>}
          {fileName && " · "}
          {formatLabel}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Transactions to add" value={p.transactionsToAdd} />
        <Stat label="Transfers to add" value={p.transfersToAdd} />
        <Stat label="Duplicates skipped" value={duplicates} />
      </dl>
      {p.walletsToCreate.length > 0 && (
        <div>
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">New wallets</h4>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {p.walletsToCreate.map((w, i) => (
              <li key={i}>
                <Badge tone="accent">
                  {w.name} · {w.currency}
                  {w.archived && " · archived"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.categoriesToCreate.length > 0 && (
        <div>
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">New categories</h4>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {p.categoriesToCreate.map((c, i) => (
              <li key={i}>
                <Badge tone={c.kind === "income" ? "income" : "expense"}>
                  {c.name} · {c.kind}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      <NoticeList notices={p.notices} />
      {p.format === "csv" && p.walletsToCreate.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A CSV carries no initial balances or archived state: new wallets start at a balance of 0 and active. Edit them
          afterwards if needed, or import a backup instead.
        </p>
      )}
      {p.format === "spendee" && p.walletsToCreate.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A Spendee export carries no starting balances: new wallets start at a balance of 0. Edit them afterwards if
          your Spendee wallet had one.
        </p>
      )}
      {nothing ? (
        <p className="text-sm text-foreground">Nothing to import: everything in this file is already in your account.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {confirm}
          <p className="text-xs text-muted-foreground">Everything is saved in one step, or nothing is.</p>
        </div>
      )}
    </div>
  );
}

function ProblemList({ problems }: { problems: ImportProblem[] }) {
  return (
    <ol className="max-h-80 space-y-1.5 overflow-y-auto text-sm">
      {problems.map((pr, i) => (
        <li key={i} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <span className="shrink-0 font-medium text-danger tabular-nums sm:min-w-20">
            {pr.line !== undefined ? `Line ${pr.line}` : pr.path ? <code className="text-xs break-all">{pr.path}</code> : "File"}
          </span>
          <span className="min-w-0 break-words text-foreground">{pr.message}</span>
        </li>
      ))}
    </ol>
  );
}

function NoticeList({ notices }: { notices: ImportNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Good to know</h4>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-foreground">
        {notices.map((n, i) => (
          <li key={i}>{n.message}</li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold text-foreground tabular-nums">{value.toLocaleString("en-US")}</dd>
    </div>
  );
}

function ImportSuccess({ result: r, fileName }: { result: ImportPreview; fileName?: string }) {
  const duplicates = r.duplicateTransactions + r.duplicateTransfers;
  const parts = [
    plural(r.transactionsToAdd, "transaction", "transactions"),
    plural(r.transfersToAdd, "transfer", "transfers"),
  ];
  return (
    <div className="space-y-3 rounded-lg border border-income/30 bg-income-soft/60 p-3 sm:p-4">
      <div role="status">
        <h3 className="text-sm font-semibold text-income">Import complete</h3>
        <p className="mt-1 text-sm text-foreground">
          Added {parts.join(" and ")}
          {fileName && (
            <>
              {" "}from <span className="font-medium break-all">{fileName}</span>
            </>
          )}
          .
          {r.walletsToCreate.length > 0 && ` Created ${plural(r.walletsToCreate.length, "wallet", "wallets")}.`}
          {r.categoriesToCreate.length > 0 && ` Created ${plural(r.categoriesToCreate.length, "category", "categories")}.`}
          {duplicates > 0 && ` Skipped ${plural(duplicates, "duplicate", "duplicates")}.`}
        </p>
      </div>
      <NoticeList notices={r.notices} />
      <div className="flex flex-wrap gap-2">
        <Link href="/" className={buttonClasses({ size: "sm" })}>
          Go to dashboard
        </Link>
        <Link href="/transactions" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          View transactions
        </Link>
      </div>
    </div>
  );
}
