import "server-only";
import { and, asc, count, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import {
  categories,
  recurringTransactions,
  transactions,
  walletGroups,
  wallets,
  type CategoryKind,
  type RecurringTransaction,
} from "@/db/schema";
import { isValidDate } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import {
  MAX_OCCURRENCES_PER_RUN,
  MAX_RECURRING_INTERVAL,
  firstOccurrenceOnOrAfter,
  isFrequency,
  occurrenceAfter,
  occurrencesBetween,
  type Frequency,
  type Schedule,
} from "@/lib/recurrence";
import { assertId, assertPositiveAmount, isPgId, normalizeNote } from "./_validate";
import { normalizeTagList, setEntryTags } from "./tags";
import { getTransaction, validateTransactionInput, type TransactionInput, type TransactionView } from "./transactions";
import { closedWalletMessage, getOwnedWalletRow } from "./wallets";

// Repeating expenses and income ("rules"). A rule turns into ordinary entries (carrying `recurringId`) on its dates,
// lazily: `materializeDueRecurring` runs once per request from `getCurrentUser` (src/lib/auth.ts) and creates every
// occurrence up to the user's today. There is no scheduler. "Today" always comes from the caller.

export type RecurringStatus = "active" | "paused" | "ended";

export type RecurringView = {
  id: number;
  kind: CategoryKind;
  walletId: number;
  walletName: string;
  currency: string;
  categoryId: number;
  categoryName: string;
  /** Always positive; the kind gives the sign. */
  amountMinor: number;
  note: string | null;
  frequency: Frequency;
  interval: number;
  /** The first occurrence (occurrences are counted from it). */
  startDate: string;
  /** Inclusive; null = no end. */
  endDate: string | null;
  /** The next occurrence not yet turned into an entry; null once the rule has ended. */
  nextDate: string | null;
  pausedAt: Date | null;
  /** ended (no next date) > paused > active. */
  status: RecurringStatus;
  /**
   * Why the rule cannot create entries right now (its wallet or the wallet's group or its category is archived), or
   * null. A rule that falls due in that state is paused; this is the reason shown next to "Paused".
   */
  blockedBy: string | null;
  /** Entries this rule created that still exist. */
  entryCount: number;
};

export type RepeatInput = {
  frequency: Frequency;
  /** Every N days / weeks / months / years, 1–99. Default 1. */
  interval?: number;
  /** Inclusive; null / undefined = no end. */
  endDate?: string | null;
};

export type RecurringUpdateInput = {
  walletId: number;
  categoryId: number;
  amountMinor: number;
  note?: string | null;
  frequency: Frequency;
  interval: number;
  /** The next occurrence. Changing it (or the frequency / interval) restarts the schedule from it. */
  nextDate: string;
  endDate?: string | null;
};

function assertFrequency(value: unknown): Frequency {
  if (!isFrequency(value)) throw new ServiceError("VALIDATION", "Choose how often it repeats.", "frequency");
  return value;
}

function assertInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_RECURRING_INTERVAL) {
    throw new ServiceError("VALIDATION", `Enter a whole number from 1 to ${MAX_RECURRING_INTERVAL}.`, "interval");
  }
  return value;
}

/** null / "" → no end; otherwise a valid date on or after `startDate` (VALIDATION on `endDate`). */
function assertEndDate(value: unknown, startDate: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isValidDate(value)) throw new ServiceError("VALIDATION", "Enter a valid end date.", "endDate");
  if (value < startDate) {
    throw new ServiceError("VALIDATION", "The end date cannot be before the first entry.", "endDate");
  }
  return value;
}

const scheduleOf = (r: Pick<RecurringTransaction, "frequency" | "interval" | "startDate" | "endDate">): Schedule => ({
  frequency: r.frequency,
  interval: r.interval,
  startDate: r.startDate,
  endDate: r.endDate,
});

// ---------------------------------------------------------------------------------------------
// Reading

function statusOf(r: { nextDate: string | null; pausedAt: Date | null }): RecurringStatus {
  if (r.nextDate === null) return "ended";
  return r.pausedAt ? "paused" : "active";
}

function blockReason(r: {
  walletName: string;
  walletArchived: boolean;
  groupName: string;
  groupArchived: boolean;
  categoryName: string;
  categoryArchived: boolean;
}): string | null {
  if (r.walletArchived) return `The wallet “${r.walletName}” is archived.`;
  if (r.groupArchived) return `The wallet “${r.walletName}” is in the archived group “${r.groupName}”.`;
  if (r.categoryArchived) return `The category “${r.categoryName}” is archived.`;
  return null;
}

function selectViews(db: DBOrTx, userId: number, ruleId?: number) {
  return db
    .select({
      id: recurringTransactions.id,
      kind: recurringTransactions.kind,
      walletId: recurringTransactions.walletId,
      walletName: wallets.name,
      currency: wallets.currency,
      walletArchived: sql<boolean>`${wallets.archivedAt} is not null`.mapWith(Boolean),
      groupName: walletGroups.name,
      groupArchived: sql<boolean>`${walletGroups.archivedAt} is not null`.mapWith(Boolean),
      categoryId: recurringTransactions.categoryId,
      categoryName: categories.name,
      categoryArchived: sql<boolean>`${categories.archivedAt} is not null`.mapWith(Boolean),
      amountMinor: recurringTransactions.amountMinor,
      note: recurringTransactions.note,
      frequency: recurringTransactions.frequency,
      interval: recurringTransactions.interval,
      startDate: recurringTransactions.startDate,
      endDate: recurringTransactions.endDate,
      nextDate: recurringTransactions.nextDate,
      pausedAt: recurringTransactions.pausedAt,
      entryCount: sql<number>`(select count(*) from ${transactions} where ${transactions.recurringId} = ${recurringTransactions.id})`.mapWith(
        Number,
      ),
    })
    .from(recurringTransactions)
    .innerJoin(wallets, eq(wallets.id, recurringTransactions.walletId))
    .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
    .innerJoin(categories, eq(categories.id, recurringTransactions.categoryId))
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        ruleId === undefined ? undefined : eq(recurringTransactions.id, ruleId),
      ),
    );
}

type ViewRow = Awaited<ReturnType<typeof selectViews>>[number];

function toView(r: ViewRow): RecurringView {
  return {
    id: r.id,
    kind: r.kind,
    walletId: r.walletId,
    walletName: r.walletName,
    currency: r.currency,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    amountMinor: r.amountMinor,
    note: r.note,
    frequency: r.frequency,
    interval: r.interval,
    startDate: r.startDate,
    endDate: r.endDate,
    nextDate: r.nextDate,
    pausedAt: r.pausedAt,
    status: statusOf(r),
    blockedBy: blockReason(r),
    entryCount: r.entryCount,
  };
}

const STATUS_ORDER: Record<RecurringStatus, number> = { active: 0, paused: 1, ended: 2 };

/** The user's rules: active ones by next date, then paused ones by next date, then ended ones; then by id. */
export async function listRecurring(userId: number): Promise<RecurringView[]> {
  const rows = (await selectViews(await getDb(), userId)).map(toView);
  return rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.nextDate ?? "").localeCompare(b.nextDate ?? "") ||
      a.id - b.id,
  );
}

/** One owned rule, or null. */
export async function getRecurring(userId: number, ruleId: number, tx?: DBOrTx): Promise<RecurringView | null> {
  if (!isPgId(ruleId)) return null;
  const [row] = await selectViews(tx ?? (await getDb()), userId, ruleId);
  return row ? toView(row) : null;
}

/** How many rules use the wallet (the delete confirmation says they go with it). */
export async function countRecurringForWallet(userId: number, walletId: number): Promise<number> {
  if (!isPgId(walletId)) return 0;
  const [row] = await (await getDb())
    .select({ n: count() })
    .from(recurringTransactions)
    .where(and(eq(recurringTransactions.userId, userId), eq(recurringTransactions.walletId, walletId)));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Turning occurrences into entries

/** The rule row, locked for the rest of `tx` (`FOR UPDATE`), or NOT_FOUND. */
async function lockRule(tx: DBOrTx, userId: number, ruleId: unknown): Promise<RecurringTransaction> {
  const [row] = isPgId(ruleId)
    ? await tx
        .select()
        .from(recurringTransactions)
        .where(and(eq(recurringTransactions.id, ruleId), eq(recurringTransactions.userId, userId)))
        .for("update")
    : [];
  if (!row) throw new ServiceError("NOT_FOUND", "Repeating entry not found.");
  return row;
}

/** Why the rule's wallet / group / category takes no new entries right now, or null. The category is read FOR SHARE. */
async function currentBlock(tx: DBOrTx, userId: number, rule: RecurringTransaction): Promise<string | null> {
  const wallet = await getOwnedWalletRow(userId, rule.walletId, tx);
  const [category] = await tx
    .select({ name: categories.name, archivedAt: categories.archivedAt })
    .from(categories)
    .where(and(eq(categories.id, rule.categoryId), eq(categories.userId, userId)))
    .for("share");
  return blockReason({
    walletName: wallet.name,
    walletArchived: wallet.archivedAt !== null,
    groupName: wallet.groupName,
    groupArchived: wallet.groupArchived,
    categoryName: category?.name ?? "",
    categoryArchived: !category || category.archivedAt !== null,
  });
}

/**
 * Inside `tx`: lock the rule and create its entries for every occurrence from `nextDate` up to `today` (at most
 * `limit`), then move `nextDate` past them (NULL when the schedule has ended). Re-checks everything under the lock,
 * so a second request that waited for the first finds nothing left to do. A rule whose wallet, wallet group or
 * category is archived is paused instead (no entries). Returns how many entries were created.
 */
async function catchUpRule(
  tx: DBOrTx,
  userId: number,
  ruleId: number,
  today: string,
  limit: number,
): Promise<{ created: number; paused: boolean }> {
  const rule = await lockRule(tx, userId, ruleId);
  if (rule.pausedAt || rule.nextDate === null || rule.nextDate > today) return { created: 0, paused: false };
  if (await currentBlock(tx, userId, rule)) {
    await tx
      .update(recurringTransactions)
      .set({ pausedAt: new Date() })
      .where(and(eq(recurringTransactions.id, rule.id), eq(recurringTransactions.userId, userId)));
    return { created: 0, paused: true };
  }
  const { dates, next } = occurrencesBetween(scheduleOf(rule), rule.nextDate, today, limit);
  if (dates.length > 0) {
    await tx.insert(transactions).values(
      dates.map((date) => ({
        userId,
        walletId: rule.walletId,
        kind: rule.kind,
        categoryId: rule.categoryId,
        amountMinor: rule.amountMinor,
        date,
        note: rule.note,
        transferId: null,
        recurringId: rule.id,
      })),
    );
  }
  await tx
    .update(recurringTransactions)
    .set({ nextDate: next })
    .where(and(eq(recurringTransactions.id, rule.id), eq(recurringTransactions.userId, userId)));
  return { created: dates.length, paused: false };
}

/**
 * Create the entries of every rule of the user that is due by `today` (the user's today, `todayInZone`): one cheap
 * query when nothing is due; otherwise one DB transaction per due rule (`catchUpRule`), at most `limitPerRule`
 * entries each per call (the rest on the next call). Safe to run from two requests at once. Called once per request
 * by `getCurrentUser`.
 */
export async function materializeDueRecurring(
  userId: number,
  today: string,
  opts: { limitPerRule?: number } = {},
): Promise<{ created: number; paused: number }> {
  if (!isValidDate(today)) throw new ServiceError("VALIDATION", "Invalid date.", "date");
  const limit = opts.limitPerRule ?? MAX_OCCURRENCES_PER_RUN;
  const db = await getDb();
  const due = await db
    .select({ id: recurringTransactions.id })
    .from(recurringTransactions)
    .where(
      and(
        eq(recurringTransactions.userId, userId),
        isNull(recurringTransactions.pausedAt),
        isNotNull(recurringTransactions.nextDate),
        lte(recurringTransactions.nextDate, today),
      ),
    )
    .orderBy(asc(recurringTransactions.id));
  let created = 0;
  let paused = 0;
  for (const { id } of due) {
    const r = await db.transaction((tx) => catchUpRule(tx, userId, id, today, limit));
    created += r.created;
    if (r.paused) paused++;
  }
  return { created, paused };
}

// ---------------------------------------------------------------------------------------------
// Mutations

/**
 * The Add form's "Repeat": create the expense / income `input` and a rule that repeats it, in one DB transaction.
 * The entry is the rule's first occurrence (`startDate` = its date); when that date is before `today`, the
 * occurrences up to today are created too (bounded like a run of `materializeDueRecurring`). Errors as
 * `createTransaction`, plus `frequency`, `interval` and `endDate`.
 */
export async function createRecurringEntry(
  userId: number,
  input: TransactionInput,
  repeat: RepeatInput,
  today: string,
): Promise<{ transaction: TransactionView; rule: RecurringView; added: number }> {
  if (!isValidDate(today)) throw new ServiceError("VALIDATION", "Invalid date.", "date");
  const db = await getDb();
  const { transactionId, ruleId, added } = await db.transaction(async (tx) => {
    const v = await validateTransactionInput(userId, input, tx);
    const tagNames = input.tags === undefined ? [] : normalizeTagList(input.tags);
    const frequency = assertFrequency(repeat.frequency);
    const interval = assertInterval(repeat.interval ?? 1);
    const endDate = assertEndDate(repeat.endDate, v.date);
    const schedule: Schedule = { frequency, interval, startDate: v.date, endDate };
    const [rule] = await tx
      .insert(recurringTransactions)
      .values({
        userId,
        walletId: v.walletId,
        kind: v.kind,
        categoryId: v.categoryId,
        amountMinor: v.amountMinor,
        note: v.note,
        frequency,
        interval,
        startDate: v.date,
        endDate,
        nextDate: occurrenceAfter(schedule, v.date),
      })
      .returning({ id: recurringTransactions.id });
    const [entry] = await tx
      .insert(transactions)
      .values({ userId, ...v, transferId: null, recurringId: rule.id })
      .returning({ id: transactions.id });
    // The tags go on this first entry only: rules do not carry tags (SPEC "Tags").
    if (tagNames.length > 0) await setEntryTags(userId, entry.id, tagNames, tx);
    const caught = await catchUpRule(tx, userId, rule.id, today, MAX_OCCURRENCES_PER_RUN);
    return { transactionId: entry.id, ruleId: rule.id, added: caught.created };
  });
  return {
    transaction: (await getTransaction(userId, transactionId))!,
    rule: (await getRecurring(userId, ruleId))!,
    added,
  };
}

/**
 * Change a rule. Only future entries follow it: entries already created stay as they are. Wallet and category follow
 * the entry rules (an archived wallet / group / category only when the rule already uses it; the category keeps the
 * rule's kind). Keeping the frequency, interval and next date keeps the schedule's anchor (`startDate`); changing any
 * of them restarts the schedule at the new `nextDate`, which must then be today or later. An end date before the next
 * date ends the rule. Then, as everywhere, the occurrences due by `today` are created.
 */
export async function updateRecurring(
  userId: number,
  ruleId: number,
  input: RecurringUpdateInput,
  today: string,
): Promise<RecurringView> {
  if (!isValidDate(today)) throw new ServiceError("VALIDATION", "Invalid date.", "date");
  const db = await getDb();
  await db.transaction(async (tx) => {
    const rule = await lockRule(tx, userId, ruleId);
    const walletId = assertId(input.walletId, "walletId", "wallet");
    const categoryId = assertId(input.categoryId, "categoryId", "category");
    const amountMinor = assertPositiveAmount(input.amountMinor);
    const note = normalizeNote(input.note);
    const frequency = assertFrequency(input.frequency);
    const interval = assertInterval(input.interval);
    if (!isValidDate(input.nextDate)) throw new ServiceError("VALIDATION", "Enter the date of the next entry.", "nextDate");

    const wallet = await getOwnedWalletRow(userId, walletId, tx);
    const closed = closedWalletMessage(wallet, "This wallet");
    if (closed && wallet.id !== rule.walletId) throw new ServiceError("VALIDATION", closed, "walletId");
    const [category] = await tx
      .select({ kind: categories.kind, name: categories.name, archivedAt: categories.archivedAt })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
      .for("share");
    if (!category) throw new ServiceError("NOT_FOUND", "Category not found.", "categoryId");
    if (category.kind !== rule.kind) {
      throw new ServiceError("VALIDATION", `Choose an ${rule.kind} category.`, "categoryId");
    }
    if (category.archivedAt && categoryId !== rule.categoryId) {
      throw new ServiceError("VALIDATION", `“${category.name}” is archived. Choose another category.`, "categoryId");
    }

    const sameSchedule =
      frequency === rule.frequency && interval === rule.interval && input.nextDate === rule.nextDate;
    if (!sameSchedule && input.nextDate < today) {
      throw new ServiceError(
        "VALIDATION",
        "Choose today or a later date: entries already made are not changed.",
        "nextDate",
      );
    }
    const startDate = sameSchedule ? rule.startDate : input.nextDate;
    const endDate = assertEndDate(input.endDate, startDate);
    const nextDate = firstOccurrenceOnOrAfter({ frequency, interval, startDate, endDate }, input.nextDate);
    await tx
      .update(recurringTransactions)
      .set({ walletId, categoryId, amountMinor, note, frequency, interval, startDate, endDate, nextDate })
      .where(and(eq(recurringTransactions.id, rule.id), eq(recurringTransactions.userId, userId)));
    await catchUpRule(tx, userId, rule.id, today, MAX_OCCURRENCES_PER_RUN);
  });
  return (await getRecurring(userId, ruleId))!;
}

/** Pause a rule: it creates nothing until resumed. Idempotent; an ended rule is left as it is. */
export async function pauseRecurring(userId: number, ruleId: number): Promise<RecurringView> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const rule = await lockRule(tx, userId, ruleId);
    if (rule.pausedAt || rule.nextDate === null) return;
    await tx
      .update(recurringTransactions)
      .set({ pausedAt: new Date() })
      .where(and(eq(recurringTransactions.id, rule.id), eq(recurringTransactions.userId, userId)));
  });
  return (await getRecurring(userId, ruleId))!;
}

/**
 * Resume a paused rule. Nothing is backfilled: it continues from the first occurrence on or after `today` (or its
 * stored next date, when that is later), and today's occurrence, if any, is created now. VALIDATION while its
 * wallet, the wallet's group or its category is archived. Idempotent.
 */
export async function resumeRecurring(userId: number, ruleId: number, today: string): Promise<RecurringView> {
  if (!isValidDate(today)) throw new ServiceError("VALIDATION", "Invalid date.", "date");
  const db = await getDb();
  await db.transaction(async (tx) => {
    const rule = await lockRule(tx, userId, ruleId);
    if (!rule.pausedAt) return;
    const blocked = await currentBlock(tx, userId, rule);
    if (blocked) throw new ServiceError("VALIDATION", `${blocked} Unarchive it first, then resume.`);
    const from = rule.nextDate === null ? null : rule.nextDate > today ? rule.nextDate : today;
    await tx
      .update(recurringTransactions)
      .set({ pausedAt: null, nextDate: from === null ? null : firstOccurrenceOnOrAfter(scheduleOf(rule), from) })
      .where(and(eq(recurringTransactions.id, rule.id), eq(recurringTransactions.userId, userId)));
    await catchUpRule(tx, userId, rule.id, today, MAX_OCCURRENCES_PER_RUN);
  });
  return (await getRecurring(userId, ruleId))!;
}

/** Delete a rule. The entries it created stay (their `recurringId` becomes NULL). */
export async function deleteRecurring(userId: number, ruleId: number): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const rule = await lockRule(tx, userId, ruleId);
    await tx
      .delete(recurringTransactions)
      .where(and(eq(recurringTransactions.id, rule.id), eq(recurringTransactions.userId, userId)));
  });
}
