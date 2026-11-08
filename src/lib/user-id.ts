// Client-safe rules for user IDs and display names (shared by forms, services, the shell and tests).

export const USER_ID_MIN = 3;
export const USER_ID_MAX = 32;
export const NAME_MAX = 80;
/** 3–32 of a–z 0–9 . _ -, starting with a letter or digit. Applied to the lowercased value. */
export const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const USER_ID_HINT = `${USER_ID_MIN}–${USER_ID_MAX} characters: letters, digits, dots, dashes and underscores; start with a letter or digit.`;

export function normalizeUserId(value: string): string {
  return value.trim().toLowerCase();
}

/** Why `value` (already normalised) is not a valid user ID, or null when it is. */
export function userIdProblem(value: string): string | null {
  if (!value) return "Choose a user ID.";
  if (value.includes("@")) return "A user ID can’t contain @.";
  if (value.length < USER_ID_MIN) return `Use at least ${USER_ID_MIN} characters.`;
  if (value.length > USER_ID_MAX) return `Use at most ${USER_ID_MAX} characters.`;
  if (!/^[a-z0-9]/.test(value)) return "Start with a letter or a digit.";
  if (!USER_ID_RE.test(value)) return "Use only letters, digits, dots, dashes and underscores.";
  return null;
}

/** First name + surname when either is set, otherwise the user ID. */
export function displayName(user: { username: string; firstName: string | null; lastName: string | null }): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return full || user.username;
}

/**
 * Two letters for the account button: the first letters of the first and last word of the display name
 * ("Ana Maria Pop" → "AP"), or the first two letters of a single word ("alex.ungur" → "AU" because `.`, `_` and `-`
 * separate words too; "demo" → "DE"). Uppercased; never empty.
 */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => Array.from(w));
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : [words[0][0], words[words.length - 1][0]];
  return letters.join("").toLocaleUpperCase();
}
