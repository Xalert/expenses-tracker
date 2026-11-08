import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { DatePicker } from "@/components/ui/date-picker";
import { MonthGrid } from "@/components/ui/month-grid";

describe("DatePicker (closed)", () => {
  it("renders the formatted date on the trigger and the ISO value in a hidden input", () => {
    const html = renderToStaticMarkup(<DatePicker id="date" name="date" required defaultValue="2026-11-05" />);
    expect(html).toContain('<input type="hidden" name="date" value="2026-11-05"/>');
    expect(html).toContain("5 Nov 2026");
    expect(html).toContain('id="date"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Clear date");
  });

  it("attaches a field error the way <Input> does", () => {
    const html = renderToStaticMarkup(<DatePicker id="date" name="date" defaultValue="2026-11-05" error="Pick a date." />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="date-error"');
  });

  it("with allowEmpty and no value shows the placeholder, no clear button and posts nothing", () => {
    const html = renderToStaticMarkup(<DatePicker id="filter-from" name="from" allowEmpty defaultValue="" />);
    expect(html).toContain("Pick a date");
    expect(html).not.toContain("Clear date");
    expect(html).not.toContain('name="from"');
  });

  it("with allowEmpty and a value shows the clear button", () => {
    const html = renderToStaticMarkup(<DatePicker id="filter-to" name="to" allowEmpty defaultValue="2026-02-01" />);
    expect(html).toContain('aria-label="Clear date"');
    expect(html).toContain('name="to" value="2026-02-01"');
    expect(html).toContain("1 Feb 2026");
  });

  it("controlled: posts `value`, and `display` / `aria-label` / `triggerClassName` restyle the trigger", () => {
    const html = renderToStaticMarkup(
      <DatePicker
        id="date"
        name="date"
        value="2026-11-07"
        defaultValue="2026-01-01"
        display="Other date"
        aria-label="Choose another date"
        triggerClassName="pill"
      />,
    );
    expect(html).toContain('<input type="hidden" name="date" value="2026-11-07"/>');
    expect(html).toContain('class="pill"');
    expect(html).toContain('aria-label="Choose another date"');
    expect(html).toContain(">Other date</button>");
    expect(html).not.toContain("7 Nov 2026");
  });

  it("treats an invalid default as empty", () => {
    const html = renderToStaticMarkup(<DatePicker id="d" name="d" allowEmpty defaultValue="2026-02-30" />);
    expect(html).toContain("Pick a date");
    expect(html).not.toContain('name="d"');
  });
});

describe("MonthGrid", () => {
  it("marks the selected month, disables months past the max and keeps one month in the Tab order", () => {
    const html = renderToStaticMarkup(<MonthGrid value="2026-03" maxMonth="2026-11" onSelect={() => {}} />);
    expect(html).toContain("2026");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true" aria-label="March 2026"/);
    expect(html).toMatch(/disabled="" aria-pressed="false" aria-label="December 2026"/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
});

describe("MonthSwitcher", () => {
  it("links to the previous and next months and opens a month picker from the label", () => {
    const html = renderToStaticMarkup(<MonthSwitcher month="2026-01" maxMonth="2026-11" />);
    expect(html).toContain('href="/?month=2025-12"');
    expect(html).toContain('href="/?month=2026-02"');
    expect(html).toContain("January 2026");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="dialog"');
  });

  it("shows the This month shortcut only away from the current month", () => {
    const current = renderToStaticMarkup(<MonthSwitcher month="2026-11" maxMonth="2026-11" />);
    expect(current).not.toContain("This month");
    const past = renderToStaticMarkup(<MonthSwitcher month="2025-11" maxMonth="2026-11" />);
    expect(past).toContain("This month");
    expect(past).toMatch(/<a [^>]*href="\/"[^>]*>This month<\/a>/);
    const custom = renderToStaticMarkup(<MonthSwitcher month="2026-10" maxMonth="2026-11" basePath="/x" />);
    expect(custom).toMatch(/<a [^>]*href="\/x"[^>]*>This month<\/a>/);
  });
});
