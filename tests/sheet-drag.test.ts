import { describe, expect, it } from "vitest";
import { sheetDragOutcome } from "@/components/ui/dialog";

describe("sheetDragOutcome", () => {
  const height = 600;

  it("closes past a third of the sheet's height, whatever the speed", () => {
    expect(sheetDragOutcome({ dy: 201, height, velocity: 0 })).toBe("close");
    expect(sheetDragOutcome({ dy: 200, height, velocity: 0 })).toBe("stay");
  });

  it("closes on a fast downward flick that moved a little", () => {
    expect(sheetDragOutcome({ dy: 60, height, velocity: 0.9 })).toBe("close");
    expect(sheetDragOutcome({ dy: 60, height, velocity: 0.3 })).toBe("stay");
  });

  it("ignores a twitch and anything that did not move down", () => {
    expect(sheetDragOutcome({ dy: 10, height, velocity: 2 })).toBe("stay");
    expect(sheetDragOutcome({ dy: 0, height, velocity: 0 })).toBe("stay");
    expect(sheetDragOutcome({ dy: 120, height, velocity: -1 })).toBe("stay");
  });
});
