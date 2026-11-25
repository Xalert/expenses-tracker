"use client";

import { useState, useSyncExternalStore } from "react";
import { FieldError, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MAX_TAGS_PER_ENTRY, TAG_SEPARATOR, cleanTagName, joinTags, splitTagInput, tagKey } from "@/lib/tags";

/** A tag the entry form offers to pick: its name and how many entries use it (most used first). */
export type TagOption = { name: string; count: number };

/** How many of the user's tags are offered at once (the ones matching what is being typed, most used first). */
export const TAG_SUGGESTIONS = 8;

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true afterwards: the suggestion buttons only exist once scripts run. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** The piece after the last comma, as typed (the tag being written), cleaned. */
function trailingPiece(value: string): string {
  const i = value.lastIndexOf(TAG_SEPARATOR);
  return cleanTagName(i < 0 ? value : value.slice(i + 1));
}

/**
 * The suggestions for `value`: the user's tags matching the piece being typed (substring, ignoring case; every tag
 * when that piece is empty or already a whole tag), the ones already in the field first, most used next.
 */
export function tagSuggestions(value: string, options: readonly TagOption[], limit = TAG_SUGGESTIONS): TagOption[] {
  const chosen = new Set(splitTagInput(value).map(tagKey));
  const piece = tagKey(trailingPiece(value));
  const known = new Set(options.map((o) => tagKey(o.name)));
  const filtering = piece !== "" && !known.has(piece);
  return options
    .filter((o) => chosen.has(tagKey(o.name)) || !filtering || tagKey(o.name).includes(piece))
    .sort((a, b) => Number(chosen.has(tagKey(b.name))) - Number(chosen.has(tagKey(a.name))) || b.count - a.count)
    .slice(0, limit);
}

/**
 * `value` with `name` toggled: removed when the field has it (ignoring case); else added, replacing the piece being
 * typed when that piece is part of `name` and not a tag itself (picking "holiday 2026" after typing "hol"); a new
 * name typed before ("my own") stays.
 */
export function toggleTag(value: string, name: string, options: readonly TagOption[]): string {
  const names = splitTagInput(value);
  const key = tagKey(name);
  if (names.some((n) => tagKey(n) === key)) return joinTags(names.filter((n) => tagKey(n) !== key));
  const piece = trailingPiece(value);
  // The piece was a search for this tag (it matched it), not a new tag of its own.
  const typing =
    piece !== "" && !options.some((o) => tagKey(o.name) === tagKey(piece)) && key.includes(tagKey(piece));
  const kept = typing ? names.filter((n) => tagKey(n) !== tagKey(piece)) : names;
  return joinTags([...kept, name]);
}

/**
 * The entry form's Tags: one text input (`name="tags"`, names separated by commas), which is all there is without
 * JavaScript. With scripts, once the field is focused or has tags, the user's tags are offered below it as toggle
 * pills (the ones matching what is typed); a name that is not a tag yet is announced as new ("created when you
 * save"). It stays one row until used, so the Add sheet stays short on phones.
 */
export function TagsField({
  id,
  defaultValue = "",
  options,
  error,
}: {
  id: string;
  defaultValue?: string;
  /** The user's tags; empty → no suggestions (typing still works). */
  options: readonly TagOption[];
  error?: string;
}) {
  const hydrated = useHydrated();
  const [value, setValue] = useState(defaultValue);
  // Opened by focus or typing, and then left open: a pill click must not race the input's blur (WebKit does not
  // focus a clicked button, so the blur would arrive with no related target).
  const [open, setOpen] = useState(defaultValue.trim() !== "");
  const names = splitTagInput(value);
  const known = new Set(options.map((o) => tagKey(o.name)));
  const fresh = names.filter((n) => !known.has(tagKey(n)));
  const suggestions = tagSuggestions(value, options);
  const show = hydrated && open;
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="sr-only">
        Tags
      </label>
      <Input
        id={id}
        name="tags"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        maxLength={1000}
        placeholder="Tags, separated by commas (optional)"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        error={error}
        aria-describedby={show && fresh.length > 0 ? hintId : undefined}
      />
      <FieldError id={id}>{error}</FieldError>
      {show && suggestions.length > 0 && (
        <div role="group" aria-label="Your tags" className="flex flex-wrap gap-1.5">
          {suggestions.map((o) => {
            const on = names.some((n) => tagKey(n) === tagKey(o.name));
            return (
              <button
                key={o.name}
                type="button"
                aria-pressed={on}
                onClick={() => setValue((v) => toggleTag(v, o.name, options))}
                className={cn(
                  "inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border px-3 text-[13px] font-semibold transition-colors sm:min-h-8",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  on
                    ? "border-accent bg-accent-soft text-accent-soft-foreground"
                    : "border-border bg-field text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                <span aria-hidden="true">{on ? "✓" : "#"}</span>
                <span className="truncate">{o.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {show && (fresh.length > 0 || names.length > MAX_TAGS_PER_ENTRY) && (
        <p id={hintId} className="text-xs text-muted-foreground" aria-live="polite">
          {names.length > MAX_TAGS_PER_ENTRY
            ? `An entry can have at most ${MAX_TAGS_PER_ENTRY} tags.`
            : `New tag${fresh.length === 1 ? "" : "s"} ${fresh.map((n) => `“${n}”`).join(", ")}: created when you save.`}
        </p>
      )}
    </div>
  );
}
