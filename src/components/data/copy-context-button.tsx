"use client";

import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "@/components/shell/icons";
import { Button, controlClasses } from "@/components/ui";
import { cn } from "@/lib/cn";

const CONTEXT_URL = "/api/export/context";

type CopyState =
  | { status: "idle" | "pending" | "copied" }
  | { status: "fallback"; text: string }
  | { status: "error"; message: string };

async function fetchContext(): Promise<string> {
  const res = await fetch(CONTEXT_URL, { cache: "no-store" });
  if (res.status === 401) throw new Error("Your session has ended. Sign in again, then copy.");
  if (!res.ok) throw new Error("The wallets and categories couldn't be loaded. Try again.");
  return res.text();
}

/**
 * "Copy" for the Wallets & categories export: fetches the same JSON as the download and puts it on the clipboard.
 * The clipboard write is started inside the click (a ClipboardItem with a pending Blob, which Safari needs) and
 * falls back to `writeText` after the fetch; when the browser refuses, the JSON is shown in a read-only, selected
 * text box to copy by hand.
 */
export function CopyContextButton() {
  const [state, setState] = useState<CopyState>({ status: "idle" });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (state.status === "fallback") {
      areaRef.current?.focus();
      areaRef.current?.select();
    }
  }, [state]);

  async function copy() {
    clearTimeout(timer.current);
    setState({ status: "pending" });
    const text = fetchContext();
    text.catch(() => {}); // handled below; keeps an early rejection from being reported as unhandled
    try {
      const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (clipboard?.write && typeof ClipboardItem !== "undefined") {
        await clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else if (clipboard?.writeText) {
        await clipboard.writeText(await text);
      } else {
        throw new Error("No clipboard");
      }
      setState({ status: "copied" });
      timer.current = setTimeout(() => setState({ status: "idle" }), 2500);
    } catch {
      try {
        setState({ status: "fallback", text: await text });
      } catch (e) {
        setState({ status: "error", message: e instanceof Error ? e.message : "Copying failed. Try again." });
      }
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={copy} pending={state.status === "pending"}>
        {state.status !== "pending" && <CopyIcon className="size-4" />}
        Copy
      </Button>
      <span role="status" aria-live="polite" className="self-center text-sm">
        {state.status === "copied" && <span className="text-income">Copied</span>}
        {state.status === "error" && <span className="text-danger">{state.message}</span>}
      </span>
      {state.status === "fallback" && (
        <div className="basis-full space-y-1.5">
          <p className="text-sm text-muted-foreground">
            Your browser didn&apos;t allow copying. The text below is selected: copy it with Ctrl+C (⌘C on a Mac).
          </p>
          <textarea
            ref={areaRef}
            readOnly
            value={state.text}
            rows={8}
            aria-label="Wallets and categories as JSON"
            className={cn(controlClasses, "py-2 font-mono text-xs")}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </>
  );
}
