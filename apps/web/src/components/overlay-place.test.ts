import { describe, expect, it } from "vitest";
import { chooseSide, placeTooltip } from "./overlay-place.ts";

describe("chooseSide", () => {
  it("keeps the preferred side when there is room", () => {
    expect(chooseSide({ top: 400, bottom: 430 }, 800, "above", 200)).toBe("above");
    expect(chooseSide({ top: 40, bottom: 70 }, 800, "below", 200)).toBe("below");
  });

  it("flips when the preferred side is shorter than the room asked for", () => {
    expect(chooseSide({ top: 40, bottom: 70 }, 800, "above", 200)).toBe("below");
    expect(chooseSide({ top: 760, bottom: 790 }, 800, "below", 200)).toBe("above");
  });
});

describe("placeTooltip", () => {
  const viewport = { width: 800, height: 600 };

  it("sits below the anchor when the bottom edge has room", () => {
    const placed = placeTooltip(
      { top: 40, bottom: 66, left: 100, width: 26 },
      { width: 80, height: 24 },
      viewport,
    );
    expect(placed.side).toBe("below");
    expect(placed.top).toBeGreaterThan(66);
  });

  it("flips above when the bottom edge is too close", () => {
    const anchor = { top: 560, bottom: 580, left: 100, width: 26 };
    const placed = placeTooltip(anchor, { width: 80, height: 24 }, viewport);
    expect(placed.side).toBe("above");
    expect(placed.top).toBeLessThan(anchor.top);
  });

  it("shifts horizontally so a tooltip near the edge stays on screen", () => {
    const placed = placeTooltip(
      { top: 40, bottom: 66, left: 780, width: 26 },
      { width: 120, height: 24 },
      viewport,
    );
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + 120).toBeLessThanOrEqual(viewport.width - 8);
  });
});
