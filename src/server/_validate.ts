import "server-only";
import { isValidDate } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";

// Internal helpers shared by the services. Not part of the public service API.

export const MAX_NOTE_LENGTH = 500;
export const MAX_NAME_LENGTH = 60;

export function assertId(value: unknown, field: string, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceError("VALIDATION", `Choose a ${label}.`, field);
  }
  return value;
}

export function assertPositiveAmount(value: unknown, field = "amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ServiceError("VALIDATION", "Enter an amount greater than zero.", field);
  }
  return value;
}

export function assertDate(value: unknown, field = "date"): string {
  if (!isValidDate(value)) throw new ServiceError("VALIDATION", "Enter a valid date.", field);
  return value;
}

export function normalizeNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ServiceError("VALIDATION", "Invalid note.", "note");
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ServiceError("VALIDATION", `Keep the note under ${MAX_NOTE_LENGTH} characters.`, "note");
  }
  return note || null;
}

export function normalizeName(value: unknown, field = "name", maxLength = MAX_NAME_LENGTH): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ServiceError("VALIDATION", "Enter a name.", field);
  if (name.length > maxLength) {
    throw new ServiceError("VALIDATION", `Keep the name under ${maxLength} characters.`, field);
  }
  return name;
}

/** True for a SQLite UNIQUE violation, whether raw (better-sqlite3) or wrapped by Drizzle (`cause`). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  }
  return false;
}
