"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isNewEntryShortcut } from "@/lib/shortcuts";
import { DEFAULT_ADD_HREF } from "./add-button";

/** Pressing N (outside text fields and dialogs) does what the floating Add button does. Renders nothing. */
export function NewEntryShortcut() {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!isNewEntryShortcut(e)) return;
      // Focus can sit on <body> while a dialog is open (after a click on its text): never stack a second one.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // Follow the Add button that is shown: a page may point it somewhere else (see AddButton).
      const button =
        document.querySelector<HTMLAnchorElement>('[data-add-button="page"]') ??
        document.querySelector<HTMLAnchorElement>('[data-add-button="default"]');
      e.preventDefault();
      router.push(button?.getAttribute("href") ?? DEFAULT_ADD_HREF);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
