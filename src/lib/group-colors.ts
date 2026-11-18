// The fixed palette of wallet-group colours. Pure, shared by the service (validation) and the UI (the dot).
// Each colour is a theme token in src/app/globals.css (`--group-<name>`, light and dark), used as `bg-group-<name>`.
// The class names are spelled out in full so Tailwind finds them.

export const GROUP_COLORS = ["red", "amber", "green", "teal", "blue", "violet"] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export const GROUP_COLOR_LABELS: Record<GroupColor, string> = {
  red: "Red",
  amber: "Amber",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
};

/** The background utility of each colour (for the dot next to a group name). */
export const GROUP_COLOR_CLASS: Record<GroupColor, string> = {
  red: "bg-group-red",
  amber: "bg-group-amber",
  green: "bg-group-green",
  teal: "bg-group-teal",
  blue: "bg-group-blue",
  violet: "bg-group-violet",
};

export function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === "string" && (GROUP_COLORS as readonly string[]).includes(value);
}
