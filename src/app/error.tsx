"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";
import { HOST_MISMATCH_MESSAGE } from "@/lib/origin-check";

/**
 * The app's error boundary (below the root layout). It names the one failure with a known cause — a form refused
 * because a reverse proxy does not pass the Host header (src/proxy.ts answers those with HOST_MISMATCH_MESSAGE) —
 * and otherwise says something went wrong; server errors arrive with a generic message and a digest anyway.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const hostMismatch = error instanceof Error && error.message === HOST_MISMATCH_MESSAGE;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-semibold text-foreground">{hostMismatch ? "Request refused" : "Something went wrong"}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {hostMismatch ? HOST_MISMATCH_MESSAGE : "The page could not be shown or the change could not be saved. Try again."}
      </p>
      <Button variant="secondary" onClick={() => retry()}>
        Try again
      </Button>
    </main>
  );
}
