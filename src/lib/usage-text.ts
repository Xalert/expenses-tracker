// How a category's use is put in words (service messages and the /categories rows). Pure.

/** "1 transaction", "3 transactions". */
export const transactionsText = (n: number) => (n === 1 ? "1 transaction" : `${n} transactions`);

/**
 * The confirmation of deleting a wallet without entries. Its repeating entries go with it (the foreign key cascades),
 * so the message says so when it has any.
 */
export function deleteWalletConfirm(walletName: string, recurringCount = 0): string {
  if (recurringCount === 0) return `Delete “${walletName}”? This can't be undone.`;
  const rules = recurringCount === 1 ? "Its repeating entry is" : `Its ${recurringCount} repeating entries are`;
  return `Delete “${walletName}”? ${rules} deleted with it. This can't be undone.`;
}

/** "3 transactions", "1 repeating entry", "3 transactions and 1 repeating entry". */
export function usageText(transactionCount: number, recurringCount: number): string {
  const rules = recurringCount === 1 ? "1 repeating entry" : `${recurringCount} repeating entries`;
  if (recurringCount === 0) return transactionsText(transactionCount);
  if (transactionCount === 0) return rules;
  return `${transactionsText(transactionCount)} and ${rules}`;
}
