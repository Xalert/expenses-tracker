import Link from "next/link";
import { cn } from "@/lib/cn";
import { WalletsViewSwitch } from "./overview-lists";

// The "All in <currency>" controls shared by Overview, the /transactions day strip and /categories: the view switch
// (links, `?view=only`) with a link to the rates page, and the notes under a converted figure.

/** "All in EUR · EUR only" plus a "Rates" link to /rates (`ratesHref` carries the way back). */
export function ConvertSwitch({
  currency,
  view,
  allHref,
  onlyHref,
  ratesHref,
}: {
  currency: string;
  view: "all" | "only";
  allHref: string;
  onlyHref: string;
  ratesHref: string;
}) {
  return (
    <div className="flex max-w-full min-w-0 items-center gap-2">
      <WalletsViewSwitch
        label="Currencies counted"
        options={[
          { label: `All in ${currency}`, href: allHref, current: view === "all" },
          { label: `${currency} only`, href: onlyHref, current: view === "only" },
        ]}
      />
      <Link
        href={ratesHref}
        className="shrink-0 text-xs font-semibold text-accent-hover hover:underline"
        aria-label="Exchange rates"
      >
        Rates
      </Link>
    </div>
  );
}

/**
 * The lines under a converted figure, and — when some currencies were left out for want of a rate — a link to set
 * one on /rates.
 */
export function ConversionNotes({
  notes,
  need,
  ratesHref,
  className,
}: {
  notes: readonly string[];
  /** Currencies to offer a rate for (`ratesNeeded`). */
  need: readonly string[];
  ratesHref: string;
  className?: string;
}) {
  if (notes.length === 0 && need.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-0.5 text-xs text-muted-foreground", className)}>
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
      {need.length > 0 && (
        <p>
          <Link href={ratesHref} className="font-semibold text-accent-hover hover:underline">
            Enter a rate for {need.join(", ")}
          </Link>
        </p>
      )}
    </div>
  );
}
