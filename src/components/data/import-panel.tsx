"use client";

import { useEffect, useRef, useState, useTransition, type DragEvent } from "react";
import { previewImportAction, runImportAction, type ImportActionState } from "@/app/(app)/data/actions";
import { Button, Card, FormError } from "@/components/ui";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_ROWS } from "@/lib/constants";
import { cn } from "@/lib/cn";
import {
  ImportSuccess,
  PreviewCard,
  UnpairedOption,
  fileSize,
  hasSomethingToImport,
  importLabel,
  plural,
} from "./import-preview";

const MB = IMPORT_MAX_BYTES / 1024 / 1024;

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
 * preview, so what is confirmed is always what was previewed. Several files are one import. Files come from the
 * (visually hidden, label-wrapped) file input or are dropped on the drop area; both just replace the selection.
 */
export function ImportPanel({
  groupCount = 1,
  targetGroup = null,
}: {
  /** How many wallet groups the user has. */
  groupCount?: number;
  /** The group new wallets go into (the selected one, else the default group); shown from two groups. */
  targetGroup?: string | null;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [unpairedAsEntries, setUnpairedAsEntries] = useState(false);
  const [state, setState] = useState<ImportActionState | null>(null);
  const [step, setStep] = useState<"preview" | "import" | null>(null);
  const [dragging, setDragging] = useState(false);
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
      setState({
        error: `${files.length} files were selected; the limit is ${IMPORT_MAX_FILES} per import.`,
      });
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
        setState({
          error: "The upload failed. Check your connection (and any proxy upload limit) and try again.",
        });
      }
    });
  }

  /** The unpaired-transfers option changes what is imported, so it re-runs the preview right away. */
  function toggleUnpaired(on: boolean) {
    setUnpairedAsEntries(on);
    submit("preview", on);
  }

  /** Cancel on the preview: back to the start (no files, no preview), focus on the file input. */
  function cancel() {
    reset({ files: [] });
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length === 0) return;
    // The input keeps no stale selection: the dropped files in state are what is uploaded.
    if (inputRef.current) inputRef.current.value = "";
    reset({ files: dropped });
  }

  const preview = state?.result ?? state?.preview;
  const imported = state?.result?.imported === true;
  const unpairedOption =
    preview && (preview.unpairedTransfers > 0 || unpairedAsEntries) ? (
      <UnpairedOption
        checked={unpairedAsEntries}
        disabled={pending}
        count={preview.unpairedTransfers}
        onChange={toggleUnpaired}
      />
    ) : null;

  return (
    <section aria-labelledby="import-heading" className="min-w-0">
      <h2 id="import-heading" className="mb-3 text-lg font-extrabold tracking-tight text-foreground">
        Import
      </h2>
      <Card className="space-y-4 p-4 sm:p-6">
        <label
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
          className={cn(
            "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-dashed px-4 py-6 text-center transition-colors",
            "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
            dragging ? "border-accent bg-accent-soft" : "border-border-strong bg-background hover:bg-surface-muted",
          )}
        >
          <input
            ref={inputRef}
            id="import-file"
            name="file"
            type="file"
            multiple
            accept=".json,.csv,.tsv,.txt,application/json,text/csv,text/tab-separated-values,text/plain"
            aria-labelledby="import-file-label"
            aria-describedby="import-file-hint"
            aria-invalid={tooBig || tooMany || undefined}
            onChange={(e) => reset({ files: Array.from(e.currentTarget.files ?? []) })}
            className="sr-only"
          />
          <UploadIcon className="size-6 text-muted-foreground" />
          <span id="import-file-label" className="text-sm font-semibold text-foreground">
            Drop files here or{" "}
            <span className="text-accent-hover underline-offset-2 hover:underline">choose files</span>
          </span>
          <span id="import-file-hint" className="text-xs text-muted-foreground">
            A backup JSON, transactions CSVs, or all of Spendee&rsquo;s per-wallet CSVs at once
          </span>
        </label>

        {files.length > 0 && (
          <div className="space-y-2">
            <ul aria-label="Selected files" className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {files.map((f, i) => (
                <li
                  key={i}
                  className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-muted px-3 py-1.5 text-xs text-foreground"
                >
                  <span className="min-w-0 truncate font-semibold" title={f.name}>
                    {f.name}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">· {fileSize(f.size)}</span>
                </li>
              ))}
            </ul>
            {(files.length > 1 || tooBig || tooMany) && (
              <p className={cn("text-xs", tooBig || tooMany ? "font-semibold text-danger" : "text-muted-foreground")}>
                {plural(files.length, "file", "files")} selected · {fileSize(totalBytes)}
                {tooMany && ` — the limit is ${IMPORT_MAX_FILES}`}
                {tooBig && ` — the limit is ${MB} MB in total`}
              </p>
            )}
          </div>
        )}

        <details className="group text-xs text-muted-foreground">
          <summary className="inline-flex min-h-11 list-none [&::-webkit-details-marker]:hidden cursor-pointer items-center gap-1 rounded-full font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">
              ›
            </span>
            What can be imported
          </summary>
          <div className="space-y-2 pb-1 pl-3">
            <p>
              Importing adds to this account: nothing is changed or deleted, and nothing is saved until you confirm.
            </p>
            <p>
              An Expenses Tracker backup (.json) or transactions CSVs (comma, semicolon or tab separated), up to {MB} MB
              and {IMPORT_MAX_ROWS.toLocaleString("en-US")} rows in total. Several files can be selected and are
              imported together, as one import; a backup has to be imported on its own.
            </p>
            <p>
              Leaving Spendee? Select <strong className="font-semibold text-foreground">all</strong> of its per-wallet
              CSV files together: a transfer&rsquo;s two sides are in different wallets&rsquo; files and are paired into
              one transfer. Dates are taken in your time zone, labels are added to the note, amounts are rounded to the
              currency&rsquo;s decimals, and missing wallets (starting at a balance of 0) and categories are created.
            </p>
          </div>
        </details>

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
            <label htmlFor="skip-duplicates" className="text-sm font-semibold text-foreground">
              Skip transactions that already exist
            </label>
            <p id="skip-duplicates-hint" className="text-xs text-muted-foreground">
              Same wallet, type, category, date, amount and note (transfers: both wallets, date, both amounts and note).
              Matched one for one: if the file has 3 identical entries and your account has 1, 2 are added.
            </p>
          </div>
        </div>

        {groupCount >= 2 && targetGroup && (
          <p className="text-xs text-muted-foreground">
            Wallets created by an import go into{" "}
            <strong className="font-semibold text-foreground">{targetGroup}</strong>; choose another group in the top
            bar first to change that. A backup can name its own groups.
          </p>
        )}

        <div>
          <Button
            variant={preview?.ok && !imported ? "secondary" : "primary"}
            onClick={() => submit("preview")}
            disabled={files.length === 0 || pending}
            pending={pending && step === "preview"}
          >
            {pending && step === "preview" ? "Checking file…" : "Preview import"}
          </Button>

          <div
            ref={resultRef}
            tabIndex={-1}
            aria-live="polite"
            className="rounded-2xl outline-none not-empty:mt-4 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {state?.error && <FormError message={state.error} />}
            {imported && state?.result && <ImportSuccess result={state.result} />}
            {!imported && preview && (
              <PreviewCard
                preview={preview}
                groupCount={groupCount}
                option={unpairedOption}
                actions={
                  preview.ok ? (
                    <>
                      <Button variant="secondary" onClick={cancel} disabled={pending}>
                        Cancel
                      </Button>
                      {hasSomethingToImport(preview) && (
                        <Button
                          onClick={() => submit("import")}
                          disabled={pending}
                          pending={pending && step === "import"}
                        >
                          {pending && step === "import" ? "Importing…" : importLabel(preview)}
                        </Button>
                      )}
                    </>
                  ) : null
                }
              />
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

/** An arrow into a tray: the drop area's icon. Decorative. */
function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}
