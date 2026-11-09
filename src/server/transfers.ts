import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { transactions, transfers, wallets } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { assertDate, assertId, assertPositiveAmount, isPgId, normalizeNote } from "./_validate";
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

async function legs(userId: number, transferId: number, tx: DBOrTx) {
  return await tx
    .select({
      kind: transactions.kind,
      walletId: transactions.walletId,
      walletName: wallets.name,
      currency: wallets.currency,
      amountMinor: transactions.amountMinor,
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(and(eq(transactions.transferId, transferId), eq(transactions.userId, userId)));
}

export async function getTransfer(userId: number, transferId: number): Promise<TransferView | null> {
  if (!isPgId(transferId)) return null;
  const db = await getDb();
  const [t] = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)));
  if (!t) return null;
  const ls = await legs(userId, transferId, db);
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

async function validate(
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

  const from = await getOwnedWalletRow(userId, fromWalletId, tx, "fromWalletId");
  const to = await getOwnedWalletRow(userId, toWalletId, tx, "toWalletId");
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
export async function createTransfer(userId: number, input: TransferInput): Promise<TransferView> {
  const db = await getDb();
  const id = await db.transaction(async (tx) => {
    const v = await validate(userId, input, tx);
    const [t] = await tx
      .insert(transfers)
      .values({ userId, date: v.date, note: v.note })
      .returning({ id: transfers.id });
    await tx
      .insert(transactions)
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
      ]);
    return t.id;
  });
  return (await getTransfer(userId, id))!;
}

/** Replace a transfer's wallets, amounts, date and note (both legs updated atomically). */
export async function updateTransfer(
  userId: number,
  transferId: number,
  input: TransferInput,
): Promise<TransferView> {
  const existing = await getTransfer(userId, transferId);
  if (!existing) throw new ServiceError("NOT_FOUND", "Transfer not found.");
  const db = await getDb();
  await db.transaction(async (tx) => {
    const v = await validate(userId, input, tx, {
      fromWalletId: existing.from.walletId,
      toWalletId: existing.to.walletId,
    });
    await tx
      .update(transfers)
      .set({ date: v.date, note: v.note })
      .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)));
    const legWhere = (kind: "transfer_out" | "transfer_in") =>
      and(
        eq(transactions.transferId, transferId),
        eq(transactions.userId, userId),
        eq(transactions.kind, kind),
      );
    await tx
      .update(transactions)
      .set({ walletId: v.fromWalletId, amountMinor: v.amountMinor, date: v.date, note: v.note })
      .where(legWhere("transfer_out"));
    await tx
      .update(transactions)
      .set({ walletId: v.toWalletId, amountMinor: v.receivedAmountMinor, date: v.date, note: v.note })
      .where(legWhere("transfer_in"));
  });
  return (await getTransfer(userId, transferId))!;
}

/** Delete a transfer and both legs. */
export async function deleteTransfer(userId: number, transferId: number): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [t] = !isPgId(transferId)
      ? []
      : await tx
          .select({ id: transfers.id })
          .from(transfers)
          .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)));
    if (!t) throw new ServiceError("NOT_FOUND", "Transfer not found.");
    await tx.delete(transactions).where(eq(transactions.transferId, transferId));
    await tx.delete(transfers).where(eq(transfers.id, transferId));
  });
}
