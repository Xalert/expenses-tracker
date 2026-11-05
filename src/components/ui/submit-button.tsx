"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

/**
 * Submit button that shows a pending state while its parent <form>'s action runs.
 * Pass `pendingLabel` to swap the text while pending (e.g. "Saving…").
 */
export function SubmitButton({ children, pendingLabel, pending, ...props }: ButtonProps & { pendingLabel?: React.ReactNode }) {
  const status = useFormStatus();
  const isPending = pending || status.pending;
  return (
    <Button type="submit" pending={isPending} {...props}>
      {isPending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
