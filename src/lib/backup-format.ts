// The versioned account backup (JSON). Pure: schema + types only, no DB access.
//
// References between entries use ids local to the file (1..n in export order), never database ids. Amounts are
// carried as integer minor units (authoritative) plus an informational decimal string; on import the two must
// agree. Unknown fields are ignored (zod strips them); an unknown `version` is rejected before this schema runs.

import { z } from "zod";
import { IMPORT_MAX_ROWS } from "./constants";

export const BACKUP_APP = "expenses-tracker";
export const BACKUP_VERSION = 1;

/** Caps for untrusted files (also enforced for CSV where they apply). */
export const BACKUP_LIMITS = {
  wallets: 1_000,
  groups: 1_000,
  categories: 1_000,
  manualRates: 10_000,
  recurring: 1_000,
  /** transactions + transfers together. */
  entries: IMPORT_MAX_ROWS,
} as const;

// Raw length caps only stop absurd input early; the real rules (names 1–60 / 1–40 after trimming, notes ≤ 500)
// are applied by the importer with the same helpers the services use.
const MAX_RAW_TEXT = 2_000;

const safeInt = z
  .number({ error: "Expected a whole number." })
  .refine(Number.isSafeInteger, { error: "Expected a whole number (integer minor units)." });
const positiveInt = safeInt.refine((v) => v > 0, { error: "Must be greater than zero." });
const localId = z
  .number({ error: "Expected a numeric id." })
  .refine((v) => Number.isSafeInteger(v) && v > 0, { error: "Ids are positive whole numbers." });
const text = z.string({ error: "Expected text." }).max(MAX_RAW_TEXT, { error: "Text is too long." });
const decimal = z.string({ error: "Expected a decimal string." }).max(40, { error: "Too long for an amount." });
const isoDate = z.string({ error: "Expected a YYYY-MM-DD date." }).max(10, { error: "Expected a YYYY-MM-DD date." });
const note = text.nullable().optional();

const currencyCode = z.string({ error: "Expected a currency code." }).max(10, { error: "Expected a currency code." });
/**
 * Optional (added after version 1 shipped): when an archived wallet / category was archived, as an ISO timestamp.
 * Restored on import; absent (older files) or on an active one it is ignored, and an archived one is archived as of
 * the import.
 */
const archivedAt = z
  .string({ error: "Expected an ISO timestamp." })
  .max(64, { error: "Expected an ISO timestamp." })
  .refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)), {
    error: "Expected an ISO timestamp such as 2026-03-01T10:00:00.000Z.",
  })
  .nullable()
  .optional();

export const backupWalletSchema = z.object({
  id: localId,
  name: text,
  currency: currencyCode,
  initialBalanceMinor: safeInt,
  initialBalance: decimal.optional(),
  archived: z.boolean({ error: "Expected true or false." }).optional().default(false),
  archivedAt,
  /** Optional: the name of the wallet group the wallet belongs to (added after version 1 shipped; old files lack it). */
  group: text.nullable().optional(),
});

/**
 * Optional (added after version 1 shipped; old files lack it): the wallet groups in display order (the array order is
 * the position), with their colour (one of `GROUP_COLORS`; anything else reads as none) and archived flag.
 */
export const backupGroupSchema = z.object({
  name: text,
  color: z.string({ error: "Expected text." }).max(40, { error: "Text is too long." }).nullable().optional(),
  archived: z.boolean({ error: "Expected true or false." }).optional().default(false),
});

export const backupCategorySchema = z.object({
  id: localId,
  name: text,
  kind: z.enum(["expense", "income"], { error: "Expected expense or income." }),
  /** Optional: added after version 1 shipped (old files lack it, and the version stays 1). */
  archived: z.boolean({ error: "Expected true or false." }).optional().default(false),
  archivedAt,
});

/**
 * Optional (added after version 1 shipped; old files lack it): the user's own exchange rates (/rates), "1 `currency` =
 * `rate` `base` from `effectiveDate` on", with the rate as the exact decimal string stored.
 */
export const backupManualRateSchema = z.object({
  currency: currencyCode,
  base: currencyCode,
  effectiveDate: isoDate,
  rate: decimal,
});

export const backupTransactionSchema = z.object({
  date: isoDate,
  kind: z.enum(["expense", "income"], { error: "Expected expense or income." }),
  walletId: localId,
  categoryId: localId,
  amountMinor: positiveInt,
  amount: decimal.optional(),
  note,
  /** Optional (added after version 1 shipped): the `recurring[].id` of the repeating entry that made it. */
  recurringId: localId.optional(),
});

/**
 * Optional (added after version 1 shipped; old files lack it): the repeating expenses and income (/recurring). The
 * wallet by the file's own wallet id, the category by `kind` + name (`category`). `nextDate` null = ended.
 */
export const backupRecurringSchema = z.object({
  id: localId,
  walletId: localId,
  kind: z.enum(["expense", "income"], { error: "Expected expense or income." }),
  category: text,
  amountMinor: positiveInt,
  amount: decimal.optional(),
  note,
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"], { error: "Expected daily, weekly, monthly or yearly." }),
  interval: safeInt.optional().default(1),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  nextDate: isoDate.nullable().optional(),
  paused: z.boolean({ error: "Expected true or false." }).optional().default(false),
});

export const backupTransferSchema = z.object({
  date: isoDate,
  note,
  fromWalletId: localId,
  toWalletId: localId,
  amountMinor: positiveInt,
  amount: decimal.optional(),
  /** Required when the two wallets' currencies differ; must equal `amountMinor` when they are the same. */
  receivedAmountMinor: positiveInt.optional(),
  receivedAmount: decimal.optional(),
});

export const backupSchema = z.object({
  app: z.literal(BACKUP_APP),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.string().max(64).optional(),
  wallets: z.array(backupWalletSchema).max(BACKUP_LIMITS.wallets, { error: `At most ${BACKUP_LIMITS.wallets} wallets.` }),
  groups: z
    .array(backupGroupSchema)
    .max(BACKUP_LIMITS.groups, { error: `At most ${BACKUP_LIMITS.groups} groups.` })
    .optional(),
  categories: z
    .array(backupCategorySchema)
    .max(BACKUP_LIMITS.categories, { error: `At most ${BACKUP_LIMITS.categories} categories.` }),
  transactions: z.array(backupTransactionSchema).max(BACKUP_LIMITS.entries, {
    error: `At most ${BACKUP_LIMITS.entries} transactions.`,
  }),
  transfers: z.array(backupTransferSchema).max(BACKUP_LIMITS.entries, {
    error: `At most ${BACKUP_LIMITS.entries} transfers.`,
  }),
  manualRates: z
    .array(backupManualRateSchema)
    .max(BACKUP_LIMITS.manualRates, { error: `At most ${BACKUP_LIMITS.manualRates} exchange rates.` })
    .optional(),
  recurring: z
    .array(backupRecurringSchema)
    .max(BACKUP_LIMITS.recurring, { error: `At most ${BACKUP_LIMITS.recurring} repeating entries.` })
    .optional(),
});

export type Backup = z.output<typeof backupSchema>;
export type BackupWallet = Backup["wallets"][number];
export type BackupGroup = NonNullable<Backup["groups"]>[number];
export type BackupCategory = Backup["categories"][number];
export type BackupTransaction = Backup["transactions"][number];
export type BackupTransfer = Backup["transfers"][number];
export type BackupManualRate = NonNullable<Backup["manualRates"]>[number];
export type BackupRecurring = NonNullable<Backup["recurring"]>[number];

/** `transactions[3].amountMinor` from a zod issue path. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out ? `.${String(key)}` : String(key);
  }
  return out || "(file)";
}
