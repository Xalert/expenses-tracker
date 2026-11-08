import Link from "next/link";
import { cn } from "@/lib/cn";
import { PlusIcon } from "./icons";

export const DEFAULT_ADD_HREF = "/transactions/new";

/**
 * The floating "+ Add" button, fixed at the bottom-right (a 60px round icon button below `sm`). `(app)/layout.tsx`
 * renders the default one; a page that wants another target (`/transactions/new?wallet=<id>`) renders its own with
 * `href`, and the default hides itself (CSS in globals.css, no JavaScript needed). The N shortcut follows whichever
 * one is shown.
 */
export function AddButton({
  href = DEFAULT_ADD_HREF,
  shellDefault = false,
}: {
  href?: string;
  /** Only `(app)/layout.tsx` sets this: marks the button a page's own AddButton replaces. */
  shellDefault?: boolean;
}) {
  return (
    <Link
      href={href}
      data-add-button={shellDefault ? "default" : "page"}
      aria-label="Add transaction"
      aria-keyshortcuts="N"
      className={cn(
        "fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 inline-flex items-center justify-center gap-2 rounded-full",
        "bg-accent font-bold text-accent-foreground shadow-lg shadow-black/25 transition-colors hover:bg-accent-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "size-[60px] sm:right-8 sm:bottom-8 sm:size-auto sm:h-14 sm:px-6 sm:text-[15px]",
      )}
    >
      <PlusIcon className="size-6 sm:size-5" strokeWidth={2.4} />
      <span className="hidden sm:inline" aria-hidden="true">
        Add
      </span>
    </Link>
  );
}
