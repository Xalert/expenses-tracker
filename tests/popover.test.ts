import { describe, expect, it } from "vitest";
import { choosePlacement } from "@/components/ui/popover";

const viewport = { top: 0, bottom: 800 };

describe("choosePlacement", () => {
  it("opens below when the panel fits there", () => {
    expect(choosePlacement({ anchor: { top: 100, bottom: 140 }, bounds: viewport, panelHeight: 360 })).toBe("below");
  });

  it("opens above when it does not fit below and there is more room above", () => {
    expect(choosePlacement({ anchor: { top: 600, bottom: 640 }, bounds: viewport, panelHeight: 360 })).toBe("above");
  });

  it("stays below when it fits nowhere but there is more room below", () => {
    expect(choosePlacement({ anchor: { top: 300, bottom: 340 }, bounds: viewport, panelHeight: 600 })).toBe("below");
  });

  it("counts the gap and the gutter: an exact fit below stays below, one pixel more flips", () => {
    // below = 800 - 8 - (440 + 8) = 344; above = 400 - 8 - 8 = 384
    const anchor = { top: 400, bottom: 440 };
    expect(choosePlacement({ anchor, bounds: viewport, panelHeight: 344 })).toBe("below");
    expect(choosePlacement({ anchor, bounds: viewport, panelHeight: 345 })).toBe("above");
  });

  it("measures against the clipping container, not only the viewport", () => {
    // A dialog body from 100 to 500: plenty of viewport below the anchor, but the body clips at 500.
    const anchor = { top: 400, bottom: 440 };
    expect(choosePlacement({ anchor, bounds: viewport, panelHeight: 300 })).toBe("below");
    expect(choosePlacement({ anchor, bounds: { top: 100, bottom: 500 }, panelHeight: 300 })).toBe("above");
  });
});
