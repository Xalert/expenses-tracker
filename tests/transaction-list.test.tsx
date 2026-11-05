import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TransactionList, transactionLabel } from "@/components/transaction-list";
import type { TransactionView } from "@/server/transactions";

const base: TransactionView = {
  id: 1,
  kind: "expense",
  walletId: 1,
  walletName: "Cash",
  currency: "EUR",
  categoryId: 3,
  categoryName: "Food",
  amountMinor: 1250,
  signedAmountMinor: -1250,
  date: "2026-03-05",
  note: "Lunch",
  transferId: null,
  counterparty: null,
};

describe("TransactionList", () => {
  it("labels categories and transfer legs", () => {
    expect(transactionLabel(base)).toBe("Food");
    const cp = { walletId: 2, walletName: "Savings", currency: "RON", amountMinor: 6200 };
    expect(transactionLabel({ ...base, kind: "transfer_out", categoryName: null, counterparty: cp })).toBe("Transfer → Savings");
    expect(transactionLabel({ ...base, kind: "transfer_in", categoryName: null, counterparty: cp })).toBe("Transfer ← Savings");
  });

  it("renders rows with signed amounts and the actions slot", () => {
    const html = renderToStaticMarkup(
      <TransactionList
        items={[base, { ...base, id: 2, kind: "income", categoryName: "Salary", signedAmountMinor: 1250, note: null }]}
        renderActions={(t) => <a href={`/transactions/${t.id}/edit`}>Edit</a>}
      />,
    );
    expect(html).toContain("Food");
    expect(html).toContain("-€12.50");
    expect(html).toContain("+€12.50");
    expect(html).toContain("5 Mar 2026 · Cash");
    expect(html).toContain('href="/transactions/2/edit"');
  });

  it("renders the empty message", () => {
    expect(renderToStaticMarkup(<TransactionList items={[]} emptyMessage="Nothing here" />)).toContain("Nothing here");
  });
});
