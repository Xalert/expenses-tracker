"use client";

import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * The main menu, in order. A new top-level destination is one more entry here; there is no other nav to update.
 * `segment` is the first route segment under `(app)` (`null` for the Overview at `/`).
 */
export const NAV_ITEMS = [
  { href: "/", label: "Overview", segment: null },
  { href: "/transactions", label: "Transactions", segment: "transactions" },
  { href: "/wallets", label: "Wallets", segment: "wallets" },
  { href: "/categories", label: "Categories", segment: "categories" },
  { href: "/data", label: "Import & export", segment: "data" },
] as const satisfies readonly { href: string; label: string; segment: string | null }[];

/** The menu entry for the page in the `children` slot, or null for a page outside the menu. */
export function activeNavHref(segment: string | null): string | null {
  return NAV_ITEMS.find((item) => item.segment === segment)?.href ?? null;
}

/**
 * The top bar's menu: pills, the active one filled. Below `sm` it is its own row that scrolls sideways (no
 * wrapping, no "more" menu).
 *
 * The active entry follows the page in the layout's `children` slot, not the URL: while a dialog route is
 * intercepted (`/transactions/new` over `/wallets`), the URL names the dialog but the page behind is still Wallets.
 */
export function MainMenu({ className }: { className?: string }) {
  const segment = useSelectedLayoutSegment();
  const active = activeNavHref(segment);
  const listRef = useRef<HTMLUListElement>(null);

  // On a phone the active pill can start off-screen ("Import & export"): scroll the row, not the page, to it.
  useLayoutEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !current || list.scrollWidth <= list.clientWidth) return;
    const left = current.offsetLeft - list.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, right - list.clientWidth + 16);
    }
  }, [active]);

  return (
    <nav aria-label="Main" className={cn("min-w-0", className)}>
      <ul
        ref={listRef}
        className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === active;
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  isActive
                    ? "bg-surface-raised text-foreground"
                    : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
