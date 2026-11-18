import { describe, expect, it } from "vitest";
import { sumCostByType, visibleCostSegments } from "./usage-cost-by-type.ts";

describe("sumCostByType", () => {
  it("adds each category", () => {
    expect(
      sumCostByType([
        { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, other: 5 },
        { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
      ]),
    ).toEqual({ input: 1.5, cacheRead: 2, cacheWrite: 3, output: 4, other: 5 });
  });
});

describe("visibleCostSegments", () => {
  it("hides other below half a cent", () => {
    const segments = visibleCostSegments({
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      other: 0.004,
    });
    expect(segments.map((s) => s.key)).toEqual(["input"]);
  });

  it("shows other when it is material", () => {
    const segments = visibleCostSegments({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      other: 0.01,
    });
    expect(segments.at(-1)?.key).toBe("other");
  });
});
