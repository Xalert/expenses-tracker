import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { transactions, transfers, wallets } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { assertDate, assertId, assertPositiveAmount, normalizeNote } from "./_validate";
import { getOwnedWalletRow } from "./wallets";

type TransferSide = { walletId: number; walletName: string; currency: string; amountMinor: number };

export type TransferView = {
  id: number;
  date: string;
  note: string | null;
  from: TransferSide;
  to: TransferSide;
};

export type TransferInput = {
  fromWalletId: number;
  toWalletId: number;
  /** Amount sent, in the source wallet's currency. */
  amountMinor: number;
  /** Amount received, in the destination wallet's currency. Required only when the currencies differ. */
  receivedAmountMinor?: number | null;
  date: string;
  note?: string | null;
};

function legs(userId: number, transferId: number, tx: DBOrTx) {
  return tx
    .select({
      kind: transactions.kind,
      walletId: transactions.walletId,
      walletName: wallets.name,
      currency: wallets.currency,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(and(eq(transactions.transferId, transferId), eq(transactions.userId, userId)))
    .all();
}

export function getTransfer(userId: number, transferId: number): TransferView | null {
  const db = getDb();
  const t = db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)))
    .get();
  if (!t) return null;
  const ls = legs(userId, transferId, db);
  const out = ls.find((l) => l.kind === "transfer_out");
  const inn = ls.find((l) => l.kind === "transfer_in");
  if (!out || !inn) return null;
  const side = ({ walletId, walletName, currency, amountMinor }: (typeof ls)[number]): TransferSide => ({
    walletId,
    walletName,
    currency,
    amountMinor,
  });
  return { id: t.id, date: t.date, note: t.note, from: side(out), to: side(inn) };
}

function validate(
  userId: number,
  input: TransferInput,
  tx: DBOrTx,
  previous?: { fromWalletId: number; toWalletId: number },
) {
  const fromWalletId = assertId(input.fromWalletId, "fromWalletId", "source wallet");
  const toWalletId = assertId(input.toWalletId, "toWalletId", "destination wallet");
  if (fromWalletId === toWalletId) {
    throw new ServiceError("VALIDATION", "Choose two different wallets.", "toWalletId");
  }
  const amountMinor = assertPositiveAmount(input.amountMinor);
  const date = assertDate(input.date);
  const note = normalizeNote(input.note);

  const from = getOwnedWalletRow(userId, fromWalletId, tx, "fromWalletId");
  const to = getOwnedWalletRow(userId, toWalletId, tx, "toWalletId");
  // Archived wallets are rejected, except when editing a transfer that already used that wallet on that side.
  if (from.archivedAt && from.id !== previous?.fromWalletId) {
    throw new ServiceError("VALIDATION", "The source wallet is archived.", "fromWalletId");
  }
  if (to.archivedAt && to.id !== previous?.toWalletId) {
    throw new ServiceError("VALIDATION", "The destination wallet is archived.", "toWalletId");
  }

  let receivedAmountMinor: number;
  if (from.currency === to.currency) {
    receivedAmountMinor = amountMinor;
  } else {
    const r = input.receivedAmountMinor;
    if (typeof r !== "number" || !Number.isSafeInteger(r) || r <= 0) {
      throw new ServiceError(
        "VALIDATION",
        `Enter the amount received in ${to.currency}.`,
        "receivedAmount",
      );
    }
    receivedAmountMinor = r;
  }
  return { fromWalletId, toWalletId, amountMinor, receivedAmountMinor, date, note };
}

/** Create a transfer row and its two legs atomically. */
export function createTransfer(userId: number, input: TransferInput): TransferView {
  const id = getDb().transaction((tx) => {
    const v = validate(userId, input, tx);
    const t = tx
      .insert(transfers)
      .values({ userId, date: v.date, note: v.note })
      .returning({ id: transfers.id })
      .get();
    tx.insert(transactions)
      .values([
        {
          userId,
          walletId: v.fromWalletId,
          kind: "transfer_out",
          categoryId: null,
          amountMinor: v.amountMinor,
          date: v.date,
          note: v.note,
          transferId: t.id,
        },
        {
          userId,
          walletId: v.toWalletId,
          kind: "transfer_in",
          categoryId: null,
          amountMinor: v.receivedAmountMinor,
          date: v.date,
          note: v.note,
          transferId: t.id,
        },
      ])
      .run();
    return t.id;
  });
  return getTransfer(userId, id)!;
}

/** Replace a transfer's wallets, amounts, date and note (both legs updated atomically). */
export function updateTransfer(userId: number, transferId: number, input: TransferInput): TransferView {
  const existing = getTransfer(userId, transferId);
  if (!existing) throw new ServiceError("NOT_FOUND", "Transfer not found.");
  getDb().transaction((tx) => {
    const v = validate(userId, input, tx, {
      fromWalletId: existing.from.walletId,
      toWalletId: existing.to.walletId,
    });
    tx.update(transfers)
      .set({ date: v.date, note: v.note })
      .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)))
      .run();
    const legWhere = (kind: "transfer_out" | "transfer_in") =>
      and(
        eq(transactions.transferId, transferId),
        eq(transactions.userId, userId),
        eq(transactions.kind, kind),
      );
    tx.update(transactions)
      .set({ walletId: v.fromWalletId, amountMinor: v.amountMinor, date: v.date, note: v.note })
      .where(legWhere("transfer_out"))
      .run();
    tx.update(transactions)
      .set({ walletId: v.toWalletId, amountMinor: v.receivedAmountMinor, date: v.date, note: v.note })
      .where(legWhere("transfer_in"))
      .run();
  });
  return getTransfer(userId, transferId)!;
}

/** Delete a transfer and both legs. */
export function deleteTransfer(userId: number, transferId: number): void {
  getDb().transaction((tx) => {
    const t = tx
      .select({ id: transfers.id })
      .from(transfers)
      .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)))
      .get();
    if (!t) throw new ServiceError("NOT_FOUND", "Transfer not found.");
    tx.delete(transactions).where(eq(transactions.transferId, transferId)).run();
    tx.delete(transfers).where(eq(transfers.id, transferId)).run();
  });
}
