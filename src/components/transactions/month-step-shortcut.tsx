"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { monthStepShortcut } from "@/lib/shortcuts";

/**
 * "[" / "]" on /transactions step to the previous / next month (hrefs null = not a single-month view); "t" goes back
 * to this month (`currentHref` null = already there). Renders nothing.
 */
export function MonthStepShortcut({
  prevHref,
  nextHref,
  currentHref,
}: {
  prevHref: string | null;
  nextHref: string | null;
  currentHref: string | null;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!prevHref && !nextHref && !currentHref) return;
    function onKeyDown(e: KeyboardEvent) {
      const step = monthStepShortcut(e);
      if (!step) return;
      const href = step === "prev" ? prevHref : step === "next" ? nextHref : currentHref;
      if (!href) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (document.querySelector("[data-expandable-open]")) return;
      e.preventDefault();
      router.push(href, { scroll: false });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, prevHref, nextHref, currentHref]);

  return null;
}
