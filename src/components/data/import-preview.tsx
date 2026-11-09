import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui";
import type { ImportFileSummary, ImportNotice, ImportPreview, ImportProblem } from "@/server/import";

// The outcome parts of the /data import panel: the preview card, the problem list and the success banner. Plain
// components with no state, so they render the same on the server (tests) as in the panel.

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Entries the confirm button imports: transactions + transfers. */
export function entriesToImport(p: ImportPreview): number {
  return p.transactionsToAdd + p.transfersToAdd;
}

/** Whether confirming would change anything (entries, or only new wallets / categories). */
export function hasSomethingToImport(p: ImportPreview): boolean {
  return entriesToImport(p) + p.walletsToCreate.length + p.groupsToCreate.length + p.categoriesToCreate.length > 0;
}

export function importLabel(p: ImportPreview): string {
  const n = entriesToImport(p);
  return n > 0 ? `Import ${plural(n, "entry", "entries")}` : "Import";
}

const subheading = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

/**
 * The preview of a selection: the problem card when it cannot be imported, otherwise "Ready to import" with the
 * counts, what will be created, and the confirm row (`actions`: Cancel + the import button, supplied by the panel).
 */
export function PreviewCard({
  preview: p,
  option,
  actions,
  groupCount = 1,
}: {
  preview: ImportPreview;
  /** How many wallet groups the user has; the groups of new wallets are named from two (or when groups are created). */
  groupCount?: number;
  /** The "unpaired transfers" checkbox, when it applies. */
  option?: ReactNode;
  /** Cancel + "Import N entries"; shown unless there is nothing to import. */
  actions?: ReactNode;
}) {
  if (!p.ok) return <ProblemCard preview={p} option={option} />;

  const showGroups = groupCount >= 2 || p.groupsToCreate.length > 0;
  const duplicates = p.duplicateTransactions + p.duplicateTransfers;
  const formats = new Set(p.files.filter((f) => !f.duplicateOf).map((f) => f.format));
  const categoryKinds = new Map<string, Set<string>>();
  for (const c of p.categoriesToCreate) {
    const key = c.name.toLowerCase();
    categoryKinds.set(key, (categoryKinds.get(key) ?? new Set()).add(c.kind));
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 bg-income-soft px-4 py-3 sm:px-5">
        <h3 className="min-w-0 text-sm font-bold break-words text-income">
          Ready to import{p.formatLabel && ` · ${p.formatLabel}`}
        </h3>
        <p className="text-xs text-muted-foreground">Nothing saved yet</p>
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        {p.files.length > 1 && <FileList files={p.files} />}
        <dl className="grid grid-cols-3 gap-3">
          <Stat label="Transactions" value={p.transactionsToAdd} />
          <Stat label="Transfers" value={p.transfersToAdd} />
          <Stat label="Duplicates skipped" value={duplicates} muted />
        </dl>
        {p.walletsToCreate.length > 0 && (
          <p className="text-sm break-words text-muted-foreground">
            New wallets:{" "}
            {p.walletsToCreate.map((w, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <strong className="font-semibold text-foreground">
                  {w.name} · {w.currency}
                </strong>
                {showGroups && <> in {w.group}</>}
                {w.archived && " (archived)"}
              </span>
            ))}
          </p>
        )}
        {p.groupsToCreate.length > 0 && (
          <p className="text-sm break-words text-muted-foreground">
            New groups:{" "}
            {p.groupsToCreate.map((g, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <strong className="font-semibold text-foreground">{g}</strong>
              </span>
            ))}
          </p>
        )}
        {p.categoriesToCreate.length > 0 && (
          <p className="text-sm break-words text-muted-foreground">
            New categories:{" "}
            {p.categoriesToCreate.map((c, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <strong className="font-semibold text-foreground">{c.name}</strong>
                {/* The kind only when the same name is created as both (e.g. Spendee's unpaired "Transfer"). */}
                {(categoryKinds.get(c.name.toLowerCase())?.size ?? 0) > 1 && ` (${c.kind})`}
              </span>
            ))}
          </p>
        )}
        {option}
        <NoticeList notices={p.notices} />
        {formats.has("csv") && p.walletsToCreate.length > 0 && (
          <p className="text-xs text-muted-foreground">
            A CSV carries no initial balances or archived state: new wallets start at a balance of 0 and active. Edit
            them afterwards if needed, or import a backup instead.
          </p>
        )}
        {formats.has("spendee") && p.walletsToCreate.length > 0 && (
          <p className="text-xs text-muted-foreground">
            A Spendee export carries no starting balances: new wallets start at a balance of 0. Edit them afterwards if
            your Spendee wallet had one.
          </p>
        )}
        {!hasSomethingToImport(p) && (
          <p className="text-sm text-foreground">
            Nothing to import: everything in {p.files.length > 1 ? "these files" : "this file"} is already in your
            account.
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-muted px-4 py-3 sm:px-5">
          {hasSomethingToImport(p) && (
            <p className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
              Everything is saved in one step, or nothing is.
            </p>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Problems: the same card shape as the preview, with a `bg-danger-soft` band. The band's heading is in the text
 * colour and the line labels in `text-danger` on the card's surface: `--danger` on `--danger-soft` is 4.4:1 in Sand,
 * under the 4.5:1 the UI direction asks for.
 */
function ProblemCard({ preview: p, option }: { preview: ImportPreview; option?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div role="alert" className="bg-danger-soft px-4 py-3 sm:px-5">
        <h3 className="text-sm font-bold text-foreground">
          {plural(p.problemCount, "problem", "problems")} found — nothing can be imported
        </h3>
        <p className="mt-0.5 text-sm text-foreground">
          {p.files.length === 1 && p.files[0].name && <span className="font-semibold break-all">{p.files[0].name}</span>}
          {p.files.length === 1 && p.files[0].name && p.formatLabel && " · "}
          {p.files.length === 1 && p.formatLabel}
          {p.files.length === 1 && p.formatLabel && ". "}
          Fix the {p.files.length > 1 ? "files" : "file"} and preview again.
        </p>
      </div>
      <div className="space-y-3 px-4 py-4 sm:px-5">
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
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    // Bottom-aligned values: "Duplicates skipped" wraps to two lines at 375px.
    <div className="flex min-w-0 flex-col justify-between">
      <dt className="text-xs leading-tight text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 text-2xl leading-none font-extrabold tracking-tight tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}
      >
        {value.toLocaleString("en-US")}
      </dd>
    </div>
  );
}

function FileList({ files }: { files: ImportFileSummary[] }) {
  return (
    <div>
      <h4 className={subheading}>{plural(files.length, "file", "files")}</h4>
      <ul className="mt-1.5 divide-y divide-surface-muted rounded-xl border border-border bg-surface text-sm">
        {files.map((f, i) => (
          <li
            key={i}
            className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
          >
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

export function UnpairedOption({
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
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3">
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
        <label htmlFor="unpaired-transfers" className="text-sm font-semibold text-foreground">
          Import unpaired transfers as income / expense
        </label>
        <p id="unpaired-transfers-hint" className="text-xs text-muted-foreground">
          {count > 0
            ? `${plural(count, "transfer row has", "transfer rows have")} no partner in the selected files. `
            : ""}
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
          <span className="shrink-0 font-semibold text-danger tabular-nums sm:max-w-56 sm:min-w-20">
            {pr.file && <span className="block break-all">{pr.file}</span>}
            {pr.line !== undefined ? (
              `Line ${pr.line}`
            ) : pr.path ? (
              <code className="text-xs break-all">{pr.path}</code>
            ) : pr.file ? null : (
              "File"
            )}
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
      <h4 className={subheading}>Good to know</h4>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-foreground">
        {notices.map((n, i) => (
          <li key={i} className="break-words">
            {n.file && n.code !== "duplicate-file" && <span className="font-semibold break-all">{n.file}: </span>}
            {n.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** After a confirmed import: what was added, the notices, and where to go next. */
export function ImportSuccess({ result: r }: { result: ImportPreview }) {
  const duplicates = r.duplicateTransactions + r.duplicateTransfers;
  const parts = [
    plural(r.transactionsToAdd, "transaction", "transactions"),
    plural(r.transfersToAdd, "transfer", "transfers"),
  ];
  const single = r.files.length === 1 ? r.files[0].name : "";
  return (
    <div className="space-y-3 rounded-2xl bg-income-soft p-4 sm:p-5">
      <div role="status">
        <h3 className="text-sm font-bold text-income">Import complete</h3>
        <p className="mt-1 text-sm text-foreground">
          Added {parts.join(" and ")}
          {single ? (
            <>
              {" "}
              from <span className="font-semibold break-all">{single}</span>
            </>
          ) : r.files.length > 1 ? (
            ` from ${plural(r.files.length, "file", "files")}`
          ) : null}
          .{r.walletsToCreate.length > 0 && ` Created ${plural(r.walletsToCreate.length, "wallet", "wallets")}.`}
          {r.groupsToCreate.length > 0 && ` Created ${plural(r.groupsToCreate.length, "group", "groups")}.`}
          {r.categoriesToCreate.length > 0 &&
            ` Created ${plural(r.categoriesToCreate.length, "category", "categories")}.`}
          {duplicates > 0 && ` Skipped ${plural(duplicates, "duplicate", "duplicates")}.`}
        </p>
      </div>
      <NoticeList notices={r.notices} />
      <div className="flex flex-wrap gap-2">
        <Link href="/" className={buttonClasses()}>
          Go to dashboard
        </Link>
        <Link href="/transactions" className={buttonClasses({ variant: "secondary" })}>
          View transactions
        </Link>
      </div>
    </div>
  );
}
