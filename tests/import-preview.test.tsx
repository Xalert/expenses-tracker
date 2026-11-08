// The /data import preview card (`PreviewCard`) and success banner rendered to HTML: counts, the "Import N entries"
// label and what will be created. Choosing files, Cancel and confirming need a browser and were checked with
// Playwright; see SPEC "Import / export" → Screen.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportSuccess, PreviewCard, importLabel } from "@/components/data/import-preview";
import type { ImportPreview } from "@/server/import";

function preview(over: Partial<ImportPreview> = {}): ImportPreview {
  return {
    format: "csv",
    formatLabel: "Transactions (CSV)",
    files: [{ name: "march.csv", format: "csv", formatLabel: "Transactions (CSV)", rows: 15 }],
    ok: true,
    transactionsToAdd: 12,
    transfersToAdd: 2,
    duplicateTransactions: 3,
    duplicateTransfers: 1,
    walletsToCreate: [],
    categoriesToCreate: [],
    problems: [],
    problemCount: 0,
    notices: [],
    unpairedTransfers: 0,
    ...over,
  };
}

/** Text content with tags removed and whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** The `<dt>` → `<dd>` pairs of the stats list. */
function stats(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)) out[m[1]] = m[2];
  return out;
}

describe("PreviewCard", () => {
  it("shows the format, the three counts and the confirm footer", () => {
    const p = preview();
    const html = renderToStaticMarkup(<PreviewCard preview={p} actions={<button>{importLabel(p)}</button>} />);
    expect(text(html)).toContain("Ready to import · Transactions (CSV)");
    expect(text(html)).toContain("Nothing saved yet");
    expect(stats(html)).toEqual({ Transactions: "12", Transfers: "2", "Duplicates skipped": "4" });
    expect(text(html)).toContain("Everything is saved in one step, or nothing is.");
    expect(html).toContain("<button>Import 14 entries</button>");
    // Nothing to create: no wallet / category lines.
    expect(text(html)).not.toContain("New wallets");
    expect(text(html)).not.toContain("New categories");
  });

  it("labels the confirm button by transactions + transfers", () => {
    expect(importLabel(preview({ transactionsToAdd: 1, transfersToAdd: 0 }))).toBe("Import 1 entry");
    expect(importLabel(preview({ transactionsToAdd: 1200, transfersToAdd: 34 }))).toBe("Import 1,234 entries");
    // Only wallets / categories to create.
    expect(importLabel(preview({ transactionsToAdd: 0, transfersToAdd: 0 }))).toBe("Import");
  });

  it("lists new wallets and categories, with the kind only for a name created as both", () => {
    const html = renderToStaticMarkup(
      <PreviewCard
        preview={preview({
          walletsToCreate: [
            { name: "Savings", currency: "EUR", archived: false },
            { name: "Old card", currency: "RON", archived: true },
          ],
          categoriesToCreate: [
            { name: "Shopping", kind: "expense" },
            { name: "Transfer", kind: "expense" },
            { name: "Transfer", kind: "income" },
          ],
        })}
      />,
    );
    expect(text(html)).toContain("New wallets: Savings · EUR , Old card · RON (archived)");
    expect(text(html)).toContain("New categories: Shopping , Transfer (expense) , Transfer (income)");
    expect(html).toContain('<strong class="font-semibold text-foreground">Savings · EUR</strong>');
    // CSV-created wallets get the "no initial balances" note.
    expect(text(html)).toContain("A CSV carries no initial balances");
  });

  it("says when there is nothing to import and drops the save sentence", () => {
    const html = renderToStaticMarkup(
      <PreviewCard
        preview={preview({ transactionsToAdd: 0, transfersToAdd: 0, duplicateTransactions: 5, duplicateTransfers: 0 })}
        actions={<button>Cancel</button>}
      />,
    );
    expect(text(html)).toContain("Nothing to import: everything in this file is already in your account.");
    expect(text(html)).not.toContain("Everything is saved in one step");
    expect(stats(html)["Duplicates skipped"]).toBe("5");
  });

  it("shows problems instead of counts when the selection cannot be imported", () => {
    const html = renderToStaticMarkup(
      <PreviewCard
        preview={preview({
          ok: false,
          problems: [{ line: 4, message: "amounts are positive; the type says which way the money goes" }],
          problemCount: 1,
        })}
        actions={<button>Import</button>}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("1 problem found — nothing can be imported");
    expect(text(html)).toContain("Line 4 amounts are positive");
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("<button>Import</button>");
  });
});

describe("ImportSuccess", () => {
  it("summarises what was added and links onwards", () => {
    const html = renderToStaticMarkup(
      <ImportSuccess result={preview({ walletsToCreate: [{ name: "Savings", currency: "EUR", archived: false }] })} />,
    );
    expect(text(html)).toContain("Import complete");
    expect(text(html)).toContain(
      "Added 12 transactions and 2 transfers from march.csv . Created 1 wallet. Skipped 4 duplicates.",
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/transactions"');
  });
});
