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
import { amountRangeLabel, type AmountRangeErrors } from "@/lib/amount-filter";
import { formatMonth, shiftMonth } from "@/lib/dates";
import { GroupDot } from "@/components/wallets/group-dot";
import { listHref, monthHref, resolveView, toggleIdHref, viewLabel, type ListParams } from "./list-params";
import { NO_SCRIPT_AMOUNT_ID, NO_SCRIPT_MONTH_ID } from "./no-script-filters";

type Option = { href: string; label: string; selected: boolean; key?: string; color?: string | null };
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
  noScriptHref,
  multiselect,
  children,
}: {
  /** A listbox whose options toggle (Category, Tag): it stays open after a pick. */
  multiselect?: boolean;
  /**
   * Without JavaScript the popover cannot open: the button is hidden (`data-needs-js`) and a link with the same label
   * to `noScriptHref` (the `<noscript>` filter form's matching select) stands in for it.
   */
  noScriptHref?: string;
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
  const triggerClass = cn(
    grouped
      ? "inline-flex min-h-11 cursor-pointer items-center gap-1 px-2 text-sm font-semibold transition-colors hover:bg-surface-muted sm:min-h-10"
      : cn(pillClasses({ selected: active }), "gap-1 pr-3"),
    "max-w-[16rem]",
    focusRing,
  );
  const label = value ? (
    <>
      <span className="sr-only">{name}: </span>
      <span className="truncate">{value}</span>
    </>
  ) : (
    name
  );
  const chip = (
    // `data-needs-js`: hidden without JavaScript (the page's <noscript> filter form takes over the listbox chips, and
    // `noScriptHref` the others).
    <div ref={anchor} className="relative" data-needs-js={popup === "listbox" || noScriptHref ? "" : undefined}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup={popup}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={triggerClass}
      >
        {label}
        <ChevronDown />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        trigger={trigger}
        id={panelId}
        role={popup}
        aria-multiselectable={multiselect}
        aria-label={popup === "dialog" ? (name === "Amount" ? "Choose an amount range" : `Choose a ${name.toLowerCase()}`) : name}
        className={panelClassName}
      >
        {children(close)}
      </Popover>
    </div>
  );
  const fallback = noScriptHref && (
    <noscript>
      <a href={noScriptHref} className={triggerClass}>
        {label}
        <ChevronDown />
      </a>
    </noscript>
  );
  if (!grouped) {
    return (
      <>
        {chip}
        {fallback}
      </>
    );
  }
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border",
        active ? "border-accent bg-accent-soft text-accent-soft-foreground" : "border-border bg-field text-foreground",
      )}
    >
      {before}
      {chip}
      {fallback}
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
    // No scrolling: this runs before the Popover is placed (see CalendarPanel in date-picker.tsx).
    (root.querySelector<HTMLElement>('[aria-selected="true"]') ?? options()[0])?.focus({ preventScroll: true });
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
      // A stable key for a toggling option: the link (and the focus on it) survives the navigation it makes.
      key={o.key ?? o.href + o.label}
      href={o.href}
      scroll={false}
      role="option"
      aria-selected={o.selected}
      tabIndex={-1}
      onClick={o.key?.startsWith("toggle-") ? undefined : onPick}
      className={cn(
        "flex min-h-10 items-center justify-between gap-3 rounded-xl px-3 text-sm font-medium",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        o.selected ? "bg-accent-soft text-accent-soft-foreground" : "text-foreground hover:bg-surface-muted",
      )}
    >
      <span className="flex min-w-0 items-center">
        {o.color && <GroupDot color={o.color} className="mr-2" />}
        <span className="truncate">{o.label}</span>
      </span>
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
        thisMonth={thisMonth}
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
 * The Amount chip's panel: "At least" / "At most" in major units (each entry is compared in its own currency) and
 * Apply, plus "Any amount" when a bound is set. A GET form (the URL holds the state); with JS it pushes a clean URL.
 * Mounted only while open: focuses the first field (the one with the error, if any).
 */
function AmountPanel({
  params,
  errors,
  onDone,
}: {
  params: ListParams;
  errors: AmountRangeErrors;
  onDone: () => void;
}) {
  const router = useRouter();
  const minRef = useRef<HTMLInputElement>(null);
  const maxRef = useRef<HTMLInputElement>(null);
  const base = { ...params, page: 1 };

  useEffect(() => {
    // No scrolling: this runs before the Popover is placed (see OptionList).
    (errors.max && !errors.min ? maxRef.current : minRef.current)?.focus({ preventScroll: true });
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const input = cn(
    "h-11 w-full min-w-0 rounded-xl border bg-field px-3 text-sm text-foreground tabular-nums",
    "placeholder:text-muted-foreground focus:border-accent focus:outline-2 focus:outline-ring/40",
  );
  const field = (side: "min" | "max", label: string, ref: React.RefObject<HTMLInputElement | null>) => {
    const error = errors[side];
    const id = `list-amount-${side}`;
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">
          {label}
        </label>
        <input
          ref={ref}
          id={id}
          name={side}
          inputMode="decimal"
          autoComplete="off"
          maxLength={32}
          defaultValue={params[side] ?? ""}
          placeholder={side === "min" ? "0" : "Any"}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : "list-amount-hint"}
          className={cn(input, error ? "border-danger" : "border-border")}
        />
        {error && (
          <p id={`${id}-error`} className="text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <form
      action="/transactions"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const value = (k: string) => {
          const v = data.get(k);
          return typeof v === "string" && v.trim() ? v.trim() : undefined;
        };
        onDone();
        router.push(listHref(base, { min: value("min"), max: value("max") }), { scroll: false });
      }}
    >
      <div className="flex gap-2">
        {field("min", "At least", minRef)}
        {field("max", "At most", maxRef)}
      </div>
      <p id="list-amount-hint" className="text-xs text-muted-foreground">
        Each entry is compared in its own currency. Both bounds are included.
      </p>
      <div className="flex items-center justify-between gap-2 border-t border-surface-muted pt-2">
        {params.min || params.max ? (
          <Link
            href={listHref(base, { min: undefined, max: undefined })}
            scroll={false}
            onClick={onDone}
            className={cn(
              "inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-muted-foreground hover:bg-surface-muted hover:text-foreground sm:min-h-10",
              focusRing,
            )}
          >
            Any amount
          </Link>
        ) : (
          <span />
        )}
        <button type="submit" className={buttonClasses({ size: "sm", className: "min-h-11 sm:min-h-10" })}>
          Apply
        </button>
      </div>
    </form>
  );
}

/** "Food", "Food +2", or `unknown` when none of the ids is known. */
function multiLabel(ids: number[] | undefined, names: Map<number, string>, unknown: string): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  const known = ids.map((id) => names.get(id)).filter((n): n is string => n !== undefined);
  if (known.length === 0) return unknown;
  return ids.length === 1 ? known[0] : `${known[0]} +${ids.length - 1}`;
}

/**
 * The /transactions filter row: chips Month · Wallet · Type · Category · Tag · Amount (each a popover; the choices are
 * links, so the URL holds the state; Category and Tag toggle several values and stay open), "Clear" when any filter
 * besides the default month is set, the search (notes, categories, tags; a GET form; Enter submits) and the Export CSV
 * link. Wraps at 375px: the search and export share the last line. An invalid amount bound is named in an alert line
 * under the row.
 */
export function FilterChips({
  params,
  thisMonth,
  wallets,
  categories,
  exportHref,
  showClear,
  tags = [],
  amountErrors = {},
}: {
  params: ListParams;
  /** The server's current month (the default view). */
  thisMonth: string;
  wallets: { id: number; name: string; currency: string; archived: boolean }[];
  categories: { id: number; name: string; kind: "expense" | "income"; color?: string | null }[];
  /** The user's tags (the Tag chip is left out when there are none and none is selected). */
  tags?: { id: number; name: string }[];
  /** Null hides the Export CSV link (nothing to export). */
  exportHref: string | null;
  showClear: boolean;
  /** `amountRangeErrors(params)`: the Amount chip's problems. */
  amountErrors?: AmountRangeErrors;
}) {
  const router = useRouter();
  const view = resolveView(params, thisMonth);
  const base = { ...params, page: 1 };

  const wallet = wallets.find((w) => w.id === params.wallet);
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
  const selectedCategories = new Set(params.categories ?? []);
  const categoryGroups: OptionGroup[] = [
    {
      options: [
        { href: listHref(base, { categories: undefined }), label: "All categories", selected: selectedCategories.size === 0 },
      ],
    },
    ...(["expense", "income"] as const)
      .map((kind) => ({
        label: kind === "expense" ? "Expense" : "Income",
        options: categories
          .filter((c) => c.kind === kind)
          .map((c) => ({
            key: `toggle-category-${c.id}`,
            href: toggleIdHref(params, "categories", c.id),
            label: c.name,
            color: c.color,
            selected: selectedCategories.has(c.id),
          })),
      }))
      .filter((g) => g.options.length > 0),
  ];

  const selectedTags = new Set(params.tags ?? []);
  const tagGroups: OptionGroup[] = [
    { options: [{ href: listHref(base, { tags: undefined }), label: "All tags", selected: selectedTags.size === 0 }] },
    ...(tags.length > 0
      ? [
          {
            options: tags.map((t) => ({
              key: `toggle-tag-${t.id}`,
              href: toggleIdHref(params, "tags", t.id),
              label: t.name,
              selected: selectedTags.has(t.id),
            })),
          },
        ]
      : []),
  ];

  const categoryValue = multiLabel(params.categories, new Map(categories.map((c) => [c.id, c.name])), "Unknown category");
  const tagValue = multiLabel(params.tags, new Map(tags.map((t) => [t.id, t.name])), "Unknown tag");
  const amountProblem = amountErrors.min ?? amountErrors.max;
  const amountValue = amountRangeLabel(params.min, params.max);

  // A single month: ‹ › step through the months (the key hints match MonthStepShortcut). Not capped at this month.
  const prevMonth = view.type === "month" ? shiftMonth(view.month, -1) : null;
  const nextMonth = view.type === "month" ? shiftMonth(view.month, 1) : null;
  const listPanel = "w-64 max-w-[calc(100vw-16px)] max-h-80 overflow-y-auto p-1.5";
  const multiPanel = "w-64 max-w-[calc(100vw-16px)] max-h-96 overflow-y-auto p-1.5";

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          name="Month"
          value={viewLabel(view, thisMonth)}
          active={view.type !== "month" || view.month !== thisMonth}
          popup="dialog"
          panelClassName="w-72 max-w-[calc(100vw-16px)]"
          noScriptHref={`#${NO_SCRIPT_MONTH_ID}`}
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
        {(categories.length > 0 || params.categories) && (
          <Chip
            name="Category"
            value={categoryValue}
            active={Boolean(params.categories)}
            popup="listbox"
            multiselect
            panelClassName={multiPanel}
          >
            {(close) => <OptionList groups={categoryGroups} onPick={close} />}
          </Chip>
        )}
        {(tags.length > 0 || params.tags) && (
          <Chip name="Tag" value={tagValue} active={Boolean(params.tags)} popup="listbox" multiselect panelClassName={multiPanel}>
            {(close) => <OptionList groups={tagGroups} onPick={close} />}
          </Chip>
        )}
        <Chip
          name="Amount"
          value={amountValue}
          active={Boolean(amountValue)}
          popup="dialog"
          panelClassName="w-72 max-w-[calc(100vw-16px)]"
          noScriptHref={`#${NO_SCRIPT_AMOUNT_ID}`}
        >
          {(close) => <AmountPanel params={params} errors={amountErrors} onDone={close} />}
        </Chip>
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
                ["category", params.categories?.join(",")],
                ["tag", params.tags?.join(",")],
                ["min", params.min],
                ["max", params.max],
                ["from", params.from],
                ["to", params.to],
                ["currency", params.currency],
                ["view", params.view],
                ["select", params.select === "page" ? "page" : params.select ? "1" : undefined],
              ] as const
            ).map(([name, value]) =>
              value !== undefined ? <input key={name} type="hidden" name={name} value={String(value)} /> : null,
            )}
            <label htmlFor="list-q" className="sr-only">
              Search notes, categories and tags
            </label>
            <input
              key={params.q ?? ""}
              id="list-q"
              name="q"
              type="search"
              maxLength={200}
              defaultValue={params.q ?? ""}
              placeholder="Search notes, tags…"
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
      {amountProblem && (
        // Not silent: an invalid bound is left out of the list and said here (the chip's panel shows it on its field).
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          Amount filter not applied: {amountProblem}
        </p>
      )}
    </div>
  );
}
