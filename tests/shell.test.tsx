import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddButton } from "@/components/shell/add-button";
import { activeNavHref, NAV_ITEMS } from "@/components/shell/nav";
import { PillPicker, Segmented } from "@/components/ui";
import { isNewEntryShortcut, type ShortcutEvent } from "@/lib/shortcuts";
import { initials } from "@/lib/user-id";

/** A stand-in for a DOM element: `closest` matches when the element sits inside one of `ancestors`. */
function el(tagName: string, opts: { ancestors?: string[]; isContentEditable?: boolean } = {}) {
  const ancestors = opts.ancestors ?? [];
  return {
    tagName,
    isContentEditable: opts.isContentEditable ?? false,
    closest(selector: string) {
      const hit = ancestors.some((a) => selector.split(/,\s*/).some((s) => s.trim() === a));
      return hit ? {} : null;
    },
  } as unknown as EventTarget;
}

/** The radio inputs in rendered markup, attribute order aside. */
function radios(html: string) {
  return [...html.matchAll(/<input type="radio"[^>]*>/g)].map(([tag]) => ({
    name: /name="([^"]*)"/.exec(tag)?.[1],
    value: /value="([^"]*)"/.exec(tag)?.[1],
    checked: / checked=""/.test(tag),
  }));
}

function key(k: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key: k, altKey: false, ctrlKey: false, metaKey: false, target: el("BODY"), ...extra };
}

describe("isNewEntryShortcut", () => {
  it("fires on n and N anywhere outside text entry", () => {
    expect(isNewEntryShortcut(key("n"))).toBe(true);
    expect(isNewEntryShortcut(key("N"))).toBe(true);
    expect(isNewEntryShortcut(key("n", { target: el("A") }))).toBe(true);
    expect(isNewEntryShortcut(key("n", { target: el("BUTTON") }))).toBe(true);
    expect(isNewEntryShortcut(key("n", { target: null }))).toBe(true);
  });

  it("ignores other keys and modified presses", () => {
    expect(isNewEntryShortcut(key("m"))).toBe(false);
    expect(isNewEntryShortcut(key("n", { ctrlKey: true }))).toBe(false);
    expect(isNewEntryShortcut(key("n", { metaKey: true }))).toBe(false);
    expect(isNewEntryShortcut(key("n", { altKey: true }))).toBe(false);
    expect(isNewEntryShortcut(key("n", { repeat: true }))).toBe(false);
    expect(isNewEntryShortcut(key("n", { isComposing: true }))).toBe(false);
    expect(isNewEntryShortcut(key("n", { defaultPrevented: true }))).toBe(false);
  });

  it("ignores typing in fields and contenteditable", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      expect(isNewEntryShortcut(key("n", { target: el(tag) }))).toBe(false);
    }
    expect(isNewEntryShortcut(key("n", { target: el("DIV", { isContentEditable: true }) }))).toBe(false);
  });

  it("ignores presses inside an open modal dialog", () => {
    const inDialog = el("BUTTON", { ancestors: ['[role="dialog"][aria-modal="true"]'] });
    expect(isNewEntryShortcut(key("n", { target: inDialog }))).toBe(false);
  });
});

describe("initials", () => {
  it("takes the first and last word's first letters, or two letters of one word", () => {
    expect(initials("Ana Maria Pop")).toBe("AP");
    expect(initials("Alex Ungur")).toBe("AU");
    expect(initials("demo")).toBe("DE");
    expect(initials("alex.ungur")).toBe("AU");
    expect(initials("x")).toBe("X");
    expect(initials("  ")).toBe("?");
    expect(initials("élise")).toBe("ÉL");
  });
});

describe("main menu", () => {
  it("lists the five destinations in order", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["Overview", "Transactions", "Wallets", "Categories", "Import & export"]);
  });

  it("maps the page segment to its entry", () => {
    expect(activeNavHref(null)).toBe("/");
    expect(activeNavHref("transactions")).toBe("/transactions");
    expect(activeNavHref("wallets")).toBe("/wallets");
    expect(activeNavHref("data")).toBe("/data");
    expect(activeNavHref("elsewhere")).toBeNull();
  });
});

describe("AddButton", () => {
  it("links to the Add form, marked as the shell default or a page's own", () => {
    const shell = renderToStaticMarkup(<AddButton shellDefault />);
    expect(shell).toContain('href="/transactions/new"');
    expect(shell).toContain('data-add-button="default"');
    expect(shell).toContain('aria-label="Add transaction"');

    const page = renderToStaticMarkup(<AddButton href="/transactions/new?wallet=3" />);
    expect(page).toContain('href="/transactions/new?wallet=3"');
    expect(page).toContain('data-add-button="page"');
  });
});

describe("Segmented and PillPicker", () => {
  const options = [
    { value: "expense", label: "Expense" },
    { value: "income", label: "Income" },
  ];

  it("Segmented renders a radio group of real radios with the given name", () => {
    const html = renderToStaticMarkup(<Segmented name="kind" options={options} defaultValue="income" aria-label="Type" />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Type"');
    expect(radios(html)).toEqual([
      { name: "kind", value: "expense", checked: false },
      { name: "kind", value: "income", checked: true },
    ]);
  });

  it("Segmented can be controlled", () => {
    const html = renderToStaticMarkup(<Segmented name="kind" options={options} value="expense" onChange={() => {}} />);
    expect(radios(html).map((r) => r.checked)).toEqual([true, false]);
  });

  it("PillPicker posts its name and value, and ties its error to the group", () => {
    const html = renderToStaticMarkup(
      <PillPicker id="categoryId" name="categoryId" options={[{ value: "1", label: "Food" }, { value: "2", label: "Rent" }]} defaultValue="2" error="Choose a category." aria-labelledby="categoryId-label" />,
    );
    expect(radios(html)).toEqual([
      { name: "categoryId", value: "1", checked: false },
      { name: "categoryId", value: "2", checked: true },
    ]);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="categoryId-error"');
    expect(html).toContain('id="categoryId-error"');
    expect(html).toContain("Choose a category.");
  });
});

describe("@modal slot", () => {
  const appDir = path.resolve(import.meta.dirname, "../src/app/(app)");
  const modalDir = path.join(appDir, "@modal");

  /** Route folders (relative to `(app)`) that hold a page.tsx, outside the slot. */
  function pageRoutes(dir = appDir, rel = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith("@")) {
        out.push(...pageRoutes(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
      } else if (entry.name === "page.tsx") {
        out.push(rel);
      }
    }
    return out;
  }

  it("has a null page or an intercepted dialog for every app route (a soft navigation must reset the slot)", () => {
    const routes = pageRoutes();
    expect(routes).toContain("wallets/[id]");
    const missing = routes.filter(
      (r) => !existsSync(path.join(modalDir, r, "page.tsx")) && !existsSync(path.join(modalDir, `(.)${r}`, "page.tsx")),
    );
    expect(missing).toEqual([]);
  });
});
