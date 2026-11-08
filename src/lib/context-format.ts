// The "Wallets & categories" context export (JSON): the account's wallets and categories only, for companion tools
// such as the Statement Importer artifact. Pure: schema + types only, no DB access.
//
// No ids, balances or transactions: just names, currencies, the archived flag and category kinds. The schema is what
// a reader of the file (the app itself, later) validates against; unknown fields are ignored (zod strips them).

import { z } from "zod";
import { BACKUP_APP, BACKUP_LIMITS } from "./backup-format";

export const CONTEXT_KIND = "context";
export const CONTEXT_VERSION = 1;

const MAX_RAW_TEXT = 2_000;
const text = z.string({ error: "Expected text." }).max(MAX_RAW_TEXT, { error: "Text is too long." });

export const contextWalletSchema = z.object({
  name: text,
  currency: z.string({ error: "Expected a currency code." }).max(10, { error: "Expected a currency code." }),
  archived: z.boolean({ error: "Expected true or false." }),
});

export const contextCategorySchema = z.object({
  name: text,
  kind: z.enum(["expense", "income"], { error: "Expected expense or income." }),
});

export const contextSchema = z.object({
  app: z.literal(BACKUP_APP),
  kind: z.literal(CONTEXT_KIND),
  version: z.literal(CONTEXT_VERSION),
  exportedAt: z.string().max(64),
  wallets: z.array(contextWalletSchema).max(BACKUP_LIMITS.wallets, { error: `At most ${BACKUP_LIMITS.wallets} wallets.` }),
  categories: z
    .array(contextCategorySchema)
    .max(BACKUP_LIMITS.categories, { error: `At most ${BACKUP_LIMITS.categories} categories.` }),
});

export type ContextExport = z.output<typeof contextSchema>;
export type ContextWallet = ContextExport["wallets"][number];
export type ContextCategory = ContextExport["categories"][number];
