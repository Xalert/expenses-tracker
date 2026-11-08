"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { previewImportAction, runImportAction, type ImportActionState } from "@/app/(app)/data/actions";
import { Badge, Button, Card, CardHeader, FormError, Label, buttonClasses } from "@/components/ui";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_ROWS } from "@/lib/constants";
import type { ImportFileSummary, ImportNotice, ImportPreview, ImportProblem } from "@/server/import";

const MB = IMPORT_MAX_BYTES / 1024 / 1024;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The browser's IANA time zone; Spendee timestamps are dated in it (the server validates it, UTC otherwise). */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/**
 * Two-step import: the chosen Files stay in state, and each step uploads them again with a fresh FormData (the
 * server re-validates on confirm; a preview is never trusted). Changing the files or an option discards the
 * preview, so what is confirmed is always what was previewed. Several files are one import.
 */
export function ImportPanel() {
  const [files, setFiles] = useState<File[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [unpairedAsEntries, setUnpairedAsEntries] = useState(false);
  const [state, setState] = useState<ImportActionState | null>(null);
  const [step, setStep] = useState<"preview" | "import" | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Move focus to the outcome so screen readers read it and keyboard users land next to the next action.
  useEffect(() => {
    if (state) resultRef.current?.focus();
  }, [state]);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const tooBig = totalBytes > IMPORT_MAX_BYTES;
  const tooMany = files.length > IMPORT_MAX_FILES;

  function reset(next: { files?: File[]; skip?: boolean }) {
    if (next.files !== undefined) {
      setFiles(next.files);
      setUnpairedAsEntries(false);
    }
    if (next.skip !== undefined) setSkipDuplicates(next.skip);
    setState(null);
  }

  function submit(kind: "preview" | "import", unpaired = unpairedAsEntries) {
    if (files.length === 0) return;
    if (tooMany) {
      setState({ error: `${files.length} files were selected; the limit is ${IMPORT_MAX_FILES} per import.` });
      return;
    }
    if (tooBig) {
      setState({
        error:
          files.length === 1
            ? `The file is larger than ${MB} MB. Split it into smaller files and import them one by one.`
            : `The selected files are larger than ${MB} MB in total. Import them in smaller groups.`,
      });
      return;
    }
    const fd = new FormData();
    for (const f of files) fd.append("file", f);
    fd.set("skipDuplicates", skipDuplicates ? "on" : "off");
    fd.set("unpairedTransfers", unpaired ? "on" : "off");
    fd.set("timeZone", browserTimeZone());
    setStep(kind);
    startTransition(async () => {
      try {
        const next = await (kind === "preview" ? previewImportAction(fd) : runImportAction(fd));
        setState(next);
        if (next.result?.imported) {
          setFiles([]);
          setUnpairedAsEntries(false);
          if (inputRef.current) inputRef.current.value = "";
        }
      } catch {
        setState({ error: "The upload failed. Check your connection (and any proxy upload limit) and try again." });
      }
    });
  }

  /** The unpaired-transfers option changes what is imported, so it re-runs the preview right away. */
  function toggleUnpaired(on: boolean) {
    setUnpairedAsEntries(on);
    submit("preview", on);
  }

  const preview = state?.result ?? state?.preview;
  const imported = state?.result?.imported === true;
  const unpairedOption =
    preview && (preview.unpairedTransfers > 0 || unpairedAsEntries) ? (
      <UnpairedOption checked={unpairedAsEntries} disabled={pending} count={preview.unpairedTransfers} onChange={toggleUnpaired} />
    ) : null;

  return (
    <Card>
      <CardHeader
        title="Import"
        description="Adds a backup, transactions CSVs or a Spendee export to this account. Nothing is changed or deleted, and nothing is saved until you confirm."
      />
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="space-y-1.5">
          <Label htmlFor="import-file">Files</Label>
          <input
            ref={inputRef}
            id="import-file"
            name="file"
            type="file"
            multiple
            accept=".json,.csv,.tsv,.txt,application/json,text/csv,text/tab-separated-values,text/plain"
            aria-describedby="import-file-hint"
            aria-invalid={tooBig || tooMany || undefined}
            onChange={(e) => reset({ files: Array.from(e.currentTarget.files ?? []) })}
            className="block w-full min-w-0 text-sm text-muted-foreground file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          {files.length > 0 && (
            <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-sm">
              <p className={tooBig || tooMany ? "font-medium text-danger" : "font-medium text-foreground"}>
                {plural(files.length, "file", "files")} selected · {kb(totalBytes)}
                {tooMany && ` — the limit is ${IMPORT_MAX_FILES}`}
                {tooBig && ` — the limit is ${MB} MB in total`}
              </p>
              {files.length > 1 && (
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground" aria-label="Selected files">
                  {files.map((f, i) => (
                    <li key={i} className="flex min-w-0 justify-between gap-3">
                      <span className="min-w-0 truncate" title={f.name}>
                        {f.name}
                      </span>
                      <span className="shrink-0 tabular-nums">{kb(f.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p id="import-file-hint" className="text-xs text-muted-foreground">
            An Expenses Tracker backup (.json) or transactions CSVs (comma, semicolon or tab separated), up to {MB} MB
            and {IMPORT_MAX_ROWS.toLocaleString("en-US")} rows in total. Several files can be selected and are imported
            together, as one import; a backup has to be imported on its own.
          </p>
          <p className="text-xs text-muted-foreground">
            Leaving Spendee? Select <strong className="font-medium text-foreground">all</strong> of its per-wallet CSV
            files together: a transfer&rsquo;s two sides are in different wallets&rsquo; files and are paired into one
            transfer. Dates are taken in your time zone, labels are added to the note, amounts are rounded to the
            currency&rsquo;s decimals, and missing wallets (starting at a balance of 0) and categories are created.
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
          disabled={files.length === 0 || pending}
          pending={pending && step === "preview"}
        >
          {pending && step === "preview" ? "Checking file…" : "Preview import"}
        </Button>

        <div ref={resultRef} tabIndex={-1} aria-live="polite" className="rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-ring">
          {state?.error && <FormError message={state.error} />}
          {imported && state?.result && <ImportSuccess result={state.result} />}
          {!imported && preview && (
            <PreviewSummary
              preview={preview}
              option={unpairedOption}
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
  option,
  confirm,
}: {
  preview: ImportPreview;
  option: React.ReactNode;
  confirm: React.ReactNode;
}) {
  if (!p.ok) {
    return (
      <div className="space-y-3 rounded-lg border border-danger/30 bg-danger-soft/50 p-3 sm:p-4">
        <div role="alert">
          <h3 className="text-sm font-semibold text-danger">
            {plural(p.problemCount, "problem", "problems")} found — nothing can be imported
          </h3>
          <p className="mt-1 text-sm text-foreground">
            {p.files.length === 1 && p.files[0].name && <span className="font-medium break-all">{p.files[0].name}</span>}
            {p.files.length === 1 && p.files[0].name && p.formatLabel && " · "}
            {p.files.length === 1 && p.formatLabel}
            {p.files.length === 1 && p.formatLabel && ". "}
            Fix the {p.files.length > 1 ? "files" : "file"} and preview again.
          </p>
        </div>
        {p.files.length > 1 && <FileList files={p.files} />}
        <ProblemList problems={p.problems} />
        {p.problemCount > p.problems.length && (
          <p className="text-xs text-muted-foreground">
            Showing the first {p.problems.length} of {p.problemCount.toLocaleString("en-US")} problems.
          </p>
        )}
        {option}
        <NoticeList notices={p.notices} />
      </div>
    );
  }

  const duplicates = p.duplicateTransactions + p.duplicateTransfers;
  const nothing = p.transactionsToAdd + p.transfersToAdd + p.walletsToCreate.length + p.categoriesToCreate.length === 0;
  const formats = new Set(p.files.filter((f) => !f.duplicateOf).map((f) => f.format));
  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-muted/60 p-3 sm:p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Ready to import</h3>
        {p.files.length === 1 && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {p.files[0].name && <span className="font-medium break-all text-foreground">{p.files[0].name}</span>}
            {p.files[0].name && " · "}
            {p.formatLabel}
          </p>
        )}
      </div>
      {p.files.length > 1 && <FileList files={p.files} />}
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
              <li key={i} className="max-w-full">
                <Badge tone="accent" className="max-w-full break-all">
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
      {option}
      <NoticeList notices={p.notices} />
      {formats.has("csv") && p.walletsToCreate.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A CSV carries no initial balances or archived state: new wallets start at a balance of 0 and active. Edit them
          afterwards if needed, or import a backup instead.
        </p>
      )}
      {formats.has("spendee") && p.walletsToCreate.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A Spendee export carries no starting balances: new wallets start at a balance of 0. Edit them afterwards if
          your Spendee wallet had one.
        </p>
      )}
      {nothing ? (
        <p className="text-sm text-foreground">
          Nothing to import: everything in {p.files.length > 1 ? "these files" : "this file"} is already in your account.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {confirm}
          <p className="text-xs text-muted-foreground">Everything is saved in one step, or nothing is.</p>
        </div>
      )}
    </div>
  );
}

function FileList({ files }: { files: ImportFileSummary[] }) {
  return (
    <div>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{plural(files.length, "file", "files")}</h4>
      <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border bg-surface text-sm">
        {files.map((f, i) => (
          <li key={i} className="flex flex-col gap-0.5 px-3 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <span className="min-w-0 font-medium break-all text-foreground">{f.name || "(unnamed)"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {f.duplicateOf !== undefined
                ? `same as ${f.duplicateOf || "(unnamed)"} — used once`
                : `${f.formatLabel ?? "Empty"}${f.formatLabel && f.rows !== null ? ` · ${plural(f.rows, "row", "rows")}` : ""}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnpairedOption({
  checked,
  disabled,
  count,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  count: number;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
      <input
        id="unpaired-transfers"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        aria-describedby="unpaired-transfers-hint"
        className="mt-0.5 size-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <div>
        <label htmlFor="unpaired-transfers" className="text-sm font-medium text-foreground">
          Import unpaired transfers as income / expense
        </label>
        <p id="unpaired-transfers-hint" className="text-xs text-muted-foreground">
          {count > 0 ? `${plural(count, "transfer row has", "transfer rows have")} no partner in the selected files. ` : ""}
          Usually that means a wallet&rsquo;s file is missing: select it too. If that wallet no longer exists, turn this
          on to import such rows as expenses (outgoing) or income (incoming) in a &ldquo;Transfer&rdquo; category.
        </p>
      </div>
    </div>
  );
}

function ProblemList({ problems }: { problems: ImportProblem[] }) {
  return (
    <ol className="max-h-80 space-y-1.5 overflow-y-auto text-sm">
      {problems.map((pr, i) => (
        <li key={i} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
          <span className="shrink-0 font-medium text-danger tabular-nums sm:max-w-56 sm:min-w-20">
            {pr.file && <span className="block break-all">{pr.file}</span>}
            {pr.line !== undefined ? `Line ${pr.line}` : pr.path ? <code className="text-xs break-all">{pr.path}</code> : pr.file ? null : "File"}
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
          <li key={i} className="break-words">
            {n.file && n.code !== "duplicate-file" && <span className="font-medium break-all">{n.file}: </span>}
            {n.message}
          </li>
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

function ImportSuccess({ result: r }: { result: ImportPreview }) {
  const duplicates = r.duplicateTransactions + r.duplicateTransfers;
  const parts = [
    plural(r.transactionsToAdd, "transaction", "transactions"),
    plural(r.transfersToAdd, "transfer", "transfers"),
  ];
  const single = r.files.length === 1 ? r.files[0].name : "";
  return (
    <div className="space-y-3 rounded-lg border border-income/30 bg-income-soft/60 p-3 sm:p-4">
      <div role="status">
        <h3 className="text-sm font-semibold text-income">Import complete</h3>
        <p className="mt-1 text-sm text-foreground">
          Added {parts.join(" and ")}
          {single ? (
            <>
              {" "}from <span className="font-medium break-all">{single}</span>
            </>
          ) : r.files.length > 1 ? (
            ` from ${plural(r.files.length, "file", "files")}`
          ) : null}
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
