import { cn } from "@/lib/cn";
import { GROUP_COLOR_CLASS, isGroupColor } from "@/lib/group-colors";

/**
 * The small coloured dot shown next to a wallet group's name. Decorative (`aria-hidden`): the name always sits next
 * to it. Renders nothing for a group without a colour.
 */
export function GroupDot({ color, className }: { color: string | null | undefined; className?: string }) {
  if (!isGroupColor(color)) return null;
  return (
    <span
      aria-hidden="true"
      data-group-color={color}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", GROUP_COLOR_CLASS[color], className)}
    />
  );
}
