// The /data import preview card (`PreviewCard`) and success banner rendered to HTML: counts, the "Import N entries"
// label and what will be created. Choosing files, Cancel and confirming need a browser and were checked with
// Playwright; see SPEC "Import / export" → Screen.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportSuccess, PreviewCard, PreviewDifferences, importLabel, previewDifferences } from "@/components/data/import-preview";
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
    groupsToCreate: [],
    categoriesToCreate: [],
    manualRatesToAdd: 0,
    recurringToAdd: 0,
    duplicateRecurring: 0,
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

  it("names the group of new wallets only from two groups or when groups are created", () => {
    const wallets = [{ name: "Till", currency: "EUR", archived: false, group: "Business", described: false }];
    const one = text(renderToStaticMarkup(<PreviewCard preview={preview({ walletsToCreate: wallets })} />));
    expect(one).toContain("Till · EUR");
    expect(one).not.toContain("in Business");
    expect(one).not.toContain("New groups");
    const two = text(renderToStaticMarkup(<PreviewCard preview={preview({ walletsToCreate: wallets })} groupCount={2} />));
    expect(two).toContain("Till · EUR in Business");
    const created = text(
      renderToStaticMarkup(<PreviewCard preview={preview({ walletsToCreate: wallets, groupsToCreate: ["Business"] })} />),
    );
    expect(created).toContain("Till · EUR in Business");
    expect(created).toContain("New groups: Business");
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
            { name: "Savings", currency: "EUR", archived: false, group: "Personal", described: false },
            { name: "Old card", currency: "RON", archived: true, group: "Personal", described: true },
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
    // CSV-created wallets without a wallet row get the "starts at 0" note.
    expect(text(html)).toContain("The CSV has no wallet rows for 1 new wallet, so it starts at a balance of 0 and active.");
  });

  it("says which new categories will be archived, and how many exchange rates a backup adds", () => {
    const html = renderToStaticMarkup(
      <PreviewCard
        preview={preview({
          format: "backup",
          categoriesToCreate: [
            { name: "Old rent", kind: "expense", archived: true },
            { name: "Gifts", kind: "income" },
            { name: "Transfer", kind: "expense" },
            { name: "Transfer", kind: "income", archived: true },
          ],
          manualRatesToAdd: 3,
        })}
      />,
    );
    expect(text(html)).toContain("New categories: Old rent (archived) , Gifts , Transfer (expense) , Transfer (income, archived)");
    expect(text(html)).toContain("Your own exchange rates: 3 to add to the Rates page.");
    // Only rates to add is still something to import.
    const onlyRates = renderToStaticMarkup(
      <PreviewCard preview={preview({ transactionsToAdd: 0, transfersToAdd: 0, manualRatesToAdd: 1 })} actions={<button>Import</button>} />,
    );
    expect(text(onlyRates)).not.toContain("Nothing to import");
    expect(onlyRates).toContain("<button>Import</button>");
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
      <ImportSuccess result={preview({ walletsToCreate: [{ name: "Savings", currency: "EUR", archived: false, group: "Personal", described: false }] })} />,
    );
    expect(text(html)).toContain("Import complete");
    expect(text(html)).toContain(
      "Added 12 transactions and 2 transfers from march.csv . Created 1 wallet. Skipped 4 duplicates.",
    );
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/transactions"');
    expect(text(renderToStaticMarkup(<ImportSuccess result={preview({ manualRatesToAdd: 2 })} />))).toContain(
      "Added 2 exchange rates.",
    );
  });
});

describe("confirmation vs preview", () => {
  it("lists only the numbers that changed since the preview", () => {
    const before = preview();
    expect(previewDifferences(before, preview())).toEqual([]);
    expect(
      previewDifferences(before, preview({ transactionsToAdd: 11, duplicateTransactions: 4, categoriesToCreate: [{ name: "Pets", kind: "expense" }] })),
    ).toEqual(["11 transactions (preview: 12)", "5 duplicates skipped (preview: 4)", "1 new category (preview: 0)"]);
  });

  it("says so on the success banner, and stays silent when nothing changed", () => {
    const changed = text(renderToStaticMarkup(<ImportSuccess result={preview({ transactionsToAdd: 11, duplicateTransactions: 4 })} previewed={preview()} />));
    expect(changed).toContain(
      "Your account changed after the preview , so these numbers differ from it: 11 transactions (preview: 12), 5 duplicates skipped (preview: 4).",
    );
    expect(text(renderToStaticMarkup(<ImportSuccess result={preview()} previewed={preview()} />))).not.toContain("changed after the preview");
    expect(text(renderToStaticMarkup(<ImportSuccess result={preview()} />))).not.toContain("changed after the preview");
  });

  it("explains new problems at confirmation on the problem card", () => {
    const failed = preview({ ok: false, problems: [{ line: 2, message: "Wallet “Cash” (EUR) is archived in your account" }], problemCount: 1, transactionsToAdd: 0 });
    const html = renderToStaticMarkup(<PreviewCard preview={failed} note={<PreviewDifferences previewed={preview()} result={failed} />} />);
    expect(text(html)).toContain("Your account changed after the preview , and the import now finds problems the preview did not");
  });
});
