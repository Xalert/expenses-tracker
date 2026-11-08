// `ExpandableRow` / `ExpandableList` rendered to HTML (the test environment has no DOM). Clicking, Escape and focus
// return were checked in the browser with Playwright (see SPEC "/transactions", As built).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpandableList, ExpandableRow, toggleOpen } from "@/components/ui/expandable-row";

function list(openId: string | null) {
  return renderToStaticMarkup(
    <ExpandableList defaultOpenId={openId}>
      <ul>
        {["1", "2", "3"].map((id) => (
          <ExpandableRow
            key={id}
            id={id}
            summary={<span>Row {id}</span>}
            panelLabel={`Edit row ${id}`}
            panel={<p>Panel {id}</p>}
          />
        ))}
      </ul>
    </ExpandableList>,
  );
}

const buttons = (html: string) => [...html.matchAll(/<button[^>]*aria-expanded="(true|false)"[^>]*>/g)].map((m) => m[1]);

describe("ExpandableRow", () => {
  it("closed: every row is a button with aria-expanded=false and no panel is rendered", () => {
    const html = list(null);
    expect(buttons(html)).toEqual(["false", "false", "false"]);
    expect(html).not.toContain("Panel");
    expect(html).not.toContain('role="region"');
    expect(html).not.toContain("<li class=\"bg-surface-open");
    expect(html).toContain("<li><button");
    expect(html).toContain('<button type="button" aria-expanded="false"');
  });

  it("open: only that row is expanded, its panel is a labelled region it controls, and the row is tinted", () => {
    const html = list("2");
    expect(buttons(html)).toEqual(["false", "true", "false"]);
    expect(html).toContain("Panel 2");
    expect(html).not.toContain("Panel 1");
    expect(html).not.toContain("Panel 3");
    const regionId = /<div id="([^"]+)" role="region" aria-label="Edit row 2" data-expandable-open="">/.exec(html)?.[1];
    expect(regionId).toBeTruthy();
    expect(html).toContain(`aria-controls="${regionId}"`);
    expect(html).toMatch(/<li class="bg-surface-open">\s*<button[^>]*aria-expanded="true"/);
    // The status line for "saved" announcements.
    expect(html).toContain('<p role="status" class="sr-only">');
  });

  it("toggleOpen: one open row at a time; clicking the open row closes it", () => {
    expect(toggleOpen(null, "1")).toBe("1");
    expect(toggleOpen("1", "2")).toBe("2");
    expect(toggleOpen("2", "2")).toBeNull();
  });

  it("must sit in an ExpandableList", () => {
    expect(() =>
      renderToStaticMarkup(<ExpandableRow id="1" summary="x" panel={null} panelLabel="x" />),
    ).toThrow(/ExpandableList/);
  });
});
