import { cn } from "@/lib/cn";
import { GROUP_COLORS, GROUP_COLOR_CLASS, GROUP_COLOR_LABELS } from "@/lib/group-colors";

/**
 * The colour radios of the wallet-group and category forms (field `color`): None, then the palette (`GROUP_COLORS`)
 * as dots, each a visually hidden radio with its colour's name for screen readers; arrow keys move the choice.
 * `defaultValue` is the colour to check ("" or null for None). `large`: 44px targets (the category editor); the group
 * forms keep their 32px swatches. A form that must reset it after a failed action remounts it (`key`).
 */
export function ColorChoice({
  idPrefix,
  defaultValue,
  large = false,
  describedBy,
}: {
  idPrefix: string;
  defaultValue?: string | null;
  large?: boolean;
  /** Id of an error line to tie to the group. */
  describedBy?: string;
}) {
  const checked = defaultValue ?? "";
  const swatch = cn(
    "relative grid cursor-pointer place-items-center rounded-full border border-border",
    "has-checked:border-foreground has-checked:ring-2 has-checked:ring-foreground/20",
    "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
    large ? "size-11" : "size-8",
  );
  const dot = large ? "size-5" : "size-4";
  return (
    <fieldset className="space-y-1.5" aria-describedby={describedBy}>
      <legend className="mb-1.5 text-sm font-semibold text-foreground">Colour</legend>
      <div className={cn("flex flex-wrap", large ? "gap-1" : "gap-2")}>
        <label className={swatch} title="No colour">
          <input type="radio" name="color" value="" defaultChecked={checked === ""} className="sr-only" id={`${idPrefix}-none`} />
          <span aria-hidden="true" className="text-xs font-bold text-muted-foreground">
            ∅
          </span>
          <span className="sr-only">No colour</span>
        </label>
        {GROUP_COLORS.map((c) => (
          <label key={c} className={swatch} title={GROUP_COLOR_LABELS[c]}>
            <input type="radio" name="color" value={c} defaultChecked={checked === c} className="sr-only" id={`${idPrefix}-${c}`} />
            <span aria-hidden="true" className={cn("rounded-full", dot, GROUP_COLOR_CLASS[c])} />
            <span className="sr-only">{GROUP_COLOR_LABELS[c]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
