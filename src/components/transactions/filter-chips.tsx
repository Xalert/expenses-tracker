"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DownloadIcon } from "@/components/shell/icons";
import { buttonClasses, pillClasses } from "@/components/ui";
import { MonthGrid } from "@/components/ui/month-grid";
import { ChevronIcon } from "@/components/ui/picker-icons";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { formatMonth, shiftMonth } from "@/lib/dates";
import { listHref, monthHref, resolveView, viewLabel, type ListParams } from "./list-params";

type Option = { href: string; label: string; selected: boolean };
type OptionGroup = { label?: string; options: Option[] };

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function ChevronDown() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="size-4 shrink-0 opacity-70" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

/**
 * A filter chip: a pill button showing the filter's name (or its value when set, in the selected-pill style) that
 * opens a popover. `popup` is "listbox" for a list of choices, "dialog" for the month picker.
 */
function Chip({
  name,
  value,
  active,
  popup,
  panelClassName,
  before,
  after,
  children,
}: {
  name: string;
  /** Shown instead of `name` when set. */
  value?: string;
  active: boolean;
  popup: "listbox" | "dialog";
  panelClassName?: string;
  /** Links joined to the chip's left / right edge as one bordered control (the month stepper). */
  before?: ReactNode;
  after?: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = () => setOpen(false);
  const grouped = Boolean(before || after);
  const chip = (
    <div ref={anchor} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup={popup}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          grouped
            ? "inline-flex min-h-11 cursor-pointer items-center gap-1 px-2 text-sm font-semibold transition-colors hover:bg-surface-muted sm:min-h-10"
            : cn(pillClasses({ selected: active }), "gap-1 pr-3"),
          "max-w-[16rem]",
          focusRing,
        )}
      >
        {value ? (
          <>
            <span className="sr-only">{name}: </span>
            <span className="truncate">{value}</span>
          </>
        ) : (
          name
        )}
        <ChevronDown />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        trigger={trigger}
        id={panelId}
        role={popup}
        aria-label={popup === "dialog" ? `Choose a ${name.toLowerCase()}` : name}
        className={panelClassName}
      >
        {children(close)}
      </Popover>
    </div>
  );
  if (!grouped) return chip;
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border",
        active ? "border-accent bg-accent-soft text-accent-soft-foreground" : "border-border bg-field text-foreground",
      )}
    >
      {before}
      {chip}
      {after}
    </div>
  );
}

const stepLink =
  "inline-flex size-11 items-center justify-center rounded-full text-current opacity-70 transition-opacity hover:opacity-100 sm:size-10 " +
  focusRing;

/** The month stepper's arrow: a plain link, so it works without JS. */
function StepLink({ href, dir, label }: { href: string; dir: "left" | "right"; label: string }) {
  return (
    <Link href={href} scroll={false} className={stepLink} aria-label={label} title={label}>
      <ChevronIcon dir={dir} />
    </Link>
  );
}

/**
 * The options of a listbox chip, as links (the filter lives in the URL). Mounted only while open: focuses the
 * selected option, and Up / Down / Home / End move between options (Enter follows the link, Tab leaves and closes).
 */
function OptionList({ groups, onPick }: { groups: OptionGroup[]; onPick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const options = () => [...root.querySelectorAll<HTMLElement>('[role="option"]')];
    (root.querySelector<HTMLElement>('[aria-selected="true"]') ?? options()[0])?.focus();
    function onKeyDown(e: KeyboardEvent) {
      const all = options();
      const i = all.indexOf(document.activeElement as HTMLElement);
      let next: number | null = null;
      if (e.key === "ArrowDown") next = Math.min(all.length - 1, i + 1);
      else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = all.length - 1;
      if (next === null) return;
      e.preventDefault();
      all[next]?.focus();
    }
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, []);

  const option = (o: Option) => (
    <Link
      key={o.href + o.label}
      href={o.href}
      scroll={false}
      role="option"
      aria-selected={o.selected}
      tabIndex={-1}
      onClick={onPick}
      className={cn(
        "flex min-h-10 items-center justify-between gap-3 rounded-xl px-3 text-sm font-medium",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        o.selected ? "bg-accent-soft text-accent-soft-foreground" : "text-foreground hover:bg-surface-muted",
      )}
    >
      <span className="truncate">{o.label}</span>
      {o.selected && <span aria-hidden="true">✓</span>}
    </Link>
  );

  return (
    <div ref={ref} role="none" className="flex flex-col">
      {groups.map((g, i) =>
        g.label ? (
          <div key={g.label} role="group" aria-label={g.label} className={cn(i > 0 && "mt-1 border-t border-surface-muted pt-1")}>
            <p aria-hidden="true" className="px-3 pt-1.5 pb-1 text-xs font-semibold text-muted-foreground">
              {g.label}
            </p>
            {g.options.map(option)}
          </div>
        ) : (
          <div key={`group-${i}`} role="none" className={cn(i > 0 && "mt-1 border-t border-surface-muted pt-1")}>
            {g.options.map(option)}
          </div>
        ),
      )}
    </div>
  );
}

/** The month chip's panel: a month grid, then ‹ previous / All time / next › links. Mounted only while open. */
function MonthPanel({
  params,
  thisMonth,
  onDone,
}: {
  params: ListParams;
  thisMonth: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const view = resolveView(params, thisMonth);
  const shown = view.type === "month" ? view.month : null;
  const base = shown ?? (view.type === "range" ? (view.from ?? view.to)!.slice(0, 7) : thisMonth);
  const prev = shiftMonth(base, -1);
  const next = shiftMonth(base, 1);
  const link = "inline-flex min-h-10 items-center rounded-full px-3 text-sm font-semibold transition-colors " + focusRing;
  return (
    <div className="flex flex-col gap-2">
      <MonthGrid
        value={shown}
        focusMonth={base}
        autoFocus
        onSelect={(m) => {
          onDone();
          router.push(monthHref(params, m, thisMonth), { scroll: false });
        }}
      />
      <div className="flex items-center justify-between gap-1 border-t border-surface-muted pt-2">
        <Link
          href={monthHref(params, prev, thisMonth)}
          scroll={false}
          onClick={onDone}
          className={cn(link, "text-muted-foreground hover:bg-surface-muted hover:text-foreground")}
          aria-label={`Previous month, ${formatMonth(prev)}`}
        >
          ‹ {formatMonth(prev).split(" ")[0].slice(0, 3)}
        </Link>
        <Link
          href={monthHref(params, "all", thisMonth)}
          scroll={false}
          onClick={onDone}
          aria-current={view.type === "all" ? "true" : undefined}
          className={cn(
            link,
            view.type === "all" ? "bg-accent-soft text-accent-soft-foreground" : "text-foreground hover:bg-surface-muted",
          )}
        >
          All time
        </Link>
        <Link
          href={monthHref(params, next, thisMonth)}
          scroll={false}
          onClick={onDone}
          className={cn(link, "text-muted-foreground hover:bg-surface-muted hover:text-foreground")}
          aria-label={`Next month, ${formatMonth(next)}`}
        >
          {formatMonth(next).split(" ")[0].slice(0, 3)} ›
        </Link>
      </div>
    </div>
  );
}

/**
 * The /transactions filter row: chips Month · Wallet · Type · Category (each a popover; the choices are links, so
 * the URL holds the state), "Clear" when any filter besides the default month is set, the note search (a GET form;
 * Enter submits) and the Export CSV link. Wraps at 375px: the search and export share the last line.
 */
export function FilterChips({
  params,
  thisMonth,
  wallets,
  categories,
  exportHref,
  showClear,
}: {
  params: ListParams;
  /** The server's current month (the default view). */
  thisMonth: string;
  wallets: { id: number; name: string; currency: string; archived: boolean }[];
  categories: { id: number; name: string; kind: "expense" | "income" }[];
  /** Null hides the Export CSV link (nothing to export). */
  exportHref: string | null;
  showClear: boolean;
}) {
  const router = useRouter();
  const view = resolveView(params, thisMonth);
  const base = { ...params, page: 1 };

  const wallet = wallets.find((w) => w.id === params.wallet);
  const category = categories.find((c) => c.id === params.category);
  const kindLabel = { expense: "Expenses", income: "Income", transfer: "Transfers" } as const;

  const walletGroups: OptionGroup[] = [
    { options: [{ href: listHref(base, { wallet: undefined }), label: "All wallets", selected: !params.wallet }] },
    {
      options: wallets.map((w) => ({
        href: listHref(base, { wallet: w.id }),
        label: `${w.name} · ${w.currency}${w.archived ? " (archived)" : ""}`,
        selected: w.id === params.wallet,
      })),
    },
  ];
  const kindGroups: OptionGroup[] = [
    {
      options: [
        { href: listHref(base, { kind: undefined }), label: "All types", selected: !params.kind },
        ...(["expense", "income", "transfer"] as const).map((k) => ({
          href: listHref(base, { kind: k }),
          label: kindLabel[k],
          selected: params.kind === k,
        })),
      ],
    },
  ];
  const categoryGroups: OptionGroup[] = [
    { options: [{ href: listHref(base, { category: undefined }), label: "All categories", selected: !params.category }] },
    ...(["expense", "income"] as const)
      .map((kind) => ({
        label: kind === "expense" ? "Expense" : "Income",
        options: categories
          .filter((c) => c.kind === kind)
          .map((c) => ({ href: listHref(base, { category: c.id }), label: c.name, selected: c.id === params.category })),
      }))
      .filter((g) => g.options.length > 0),
  ];

  // A single month: ‹ › step through the months (the key hints match MonthStepShortcut). Not capped at this month.
  const prevMonth = view.type === "month" ? shiftMonth(view.month, -1) : null;
  const nextMonth = view.type === "month" ? shiftMonth(view.month, 1) : null;
  const listPanel = "w-64 max-w-[calc(100vw-16px)] max-h-80 overflow-y-auto p-1.5";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Chip
        name="Month"
        value={viewLabel(view, thisMonth)}
        active={view.type !== "month" || view.month !== thisMonth}
        popup="dialog"
        panelClassName="w-72 max-w-[calc(100vw-16px)]"
        before={
          prevMonth && (
            <StepLink
              href={monthHref(params, prevMonth, thisMonth)}
              dir="left"
              label={`Previous month, ${formatMonth(prevMonth)} ([)`}
            />
          )
        }
        after={
          nextMonth && (
            <StepLink
              href={monthHref(params, nextMonth, thisMonth)}
              dir="right"
              label={`Next month, ${formatMonth(nextMonth)} (])`}
            />
          )
        }
      >
        {(close) => <MonthPanel params={params} thisMonth={thisMonth} onDone={close} />}
      </Chip>
      {!(view.type === "month" && view.month === thisMonth) && (
        <Link
          href={monthHref(params, thisMonth, thisMonth)}
          scroll={false}
          title="This month (T)"
          className={cn(
            "inline-flex min-h-11 items-center rounded-full px-2 text-sm font-semibold text-accent hover:underline sm:min-h-10",
            focusRing,
          )}
        >
          This month
        </Link>
      )}
      {wallets.length > 0 && (
        <Chip name="Wallet" value={wallet?.name} active={Boolean(wallet)} popup="listbox" panelClassName={listPanel}>
          {(close) => <OptionList groups={walletGroups} onPick={close} />}
        </Chip>
      )}
      <Chip
        name="Type"
        value={params.kind ? kindLabel[params.kind] : undefined}
        active={Boolean(params.kind)}
        popup="listbox"
        panelClassName={listPanel}
      >
        {(close) => <OptionList groups={kindGroups} onPick={close} />}
      </Chip>
      {categories.length > 0 && (
        <Chip name="Category" value={category?.name} active={Boolean(category)} popup="listbox" panelClassName={listPanel}>
          {(close) => <OptionList groups={categoryGroups} onPick={close} />}
        </Chip>
      )}
      {showClear && (
        <Link
          href="/transactions"
          className={cn("rounded-full px-2 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline", focusRing)}
        >
          Clear
        </Link>
      )}

      <div className="flex w-full min-w-0 items-center gap-2 sm:ml-auto sm:w-auto">
        <form
          action="/transactions"
          role="search"
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
          onSubmit={(e) => {
            // With JS: a clean URL (an empty search leaves `q` out). Without: the hidden fields keep the filters.
            e.preventDefault();
            const q = new FormData(e.currentTarget).get("q");
            router.push(listHref(base, { q: typeof q === "string" && q.trim() ? q.trim() : undefined }), { scroll: false });
          }}
        >
          {(
            [
              ["month", params.month],
              ["wallet", params.wallet],
              ["kind", params.kind],
              ["category", params.category],
              ["from", params.from],
              ["to", params.to],
              ["currency", params.currency],
            ] as const
          ).map(([name, value]) =>
            value !== undefined ? <input key={name} type="hidden" name={name} value={String(value)} /> : null,
          )}
          <label htmlFor="list-q" className="sr-only">
            Search notes
          </label>
          <input
            key={params.q ?? ""}
            id="list-q"
            name="q"
            type="search"
            maxLength={200}
            defaultValue={params.q ?? ""}
            placeholder="Search notes"
            autoComplete="off"
            className={cn(
              "h-11 w-full min-w-0 rounded-full border bg-field px-4 text-sm text-foreground sm:h-10",
              "placeholder:text-muted-foreground focus:border-accent focus:outline-2 focus:outline-ring/40",
              params.q ? "border-accent" : "border-border",
            )}
          />
        </form>
        {exportHref && (
          // A plain <a>: the route handler answers with a file download (every row matching the current filters).
          <a
            href={exportHref}
            download
            className={buttonClasses({ variant: "secondary", className: "shrink-0 sm:h-10" })}
            title="Export the transactions shown (every page) as CSV"
          >
            <DownloadIcon className="size-4" />
            Export CSV
          </a>
        )}
      </div>
    </div>
  );
}
