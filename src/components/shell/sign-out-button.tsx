import { signOutAction } from "@/app/(app)/actions";
import { cn } from "@/lib/cn";
import { SubmitButton } from "@/components/ui/submit-button";
import { LogOutIcon } from "./icons";

export function SignOutButton({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <form action={signOutAction} className={className}>
      <SubmitButton variant="ghost" size="sm" className={cn(!compact && "w-full justify-start")} aria-label={compact ? "Sign out" : undefined}>
        <LogOutIcon className="size-4" />
        {!compact && "Sign out"}
      </SubmitButton>
    </form>
  );
}
