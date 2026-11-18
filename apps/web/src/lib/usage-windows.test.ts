import { describe, expect, it } from "vitest";
import { bucketPeriodKey, enumeratePeriodKeys, windowBounds } from "./usage-windows.ts";

describe("windowBounds", () => {
  it("uses a rolling 24 hours for day 1", () => {
    const now = Date.parse("2026-11-18T15:00:00Z");
    const { sinceMs, untilMs, resolution } = windowBounds(1, now, "UTC");
    expect(untilMs).toBe(now);
    expect(now - sinceMs).toBe(24 * 60 * 60 * 1000);
    expect(resolution).toBe("hour");
  });

  it("anchors calendar windows in the requested zone", () => {
    const now = Date.parse("2026-11-18T05:00:00Z");
    const { sinceMs, resolution } = windowBounds(7, now, "America/New_York");
    expect(resolution).toBe("day");
    expect(sinceMs).toBeLessThan(now);
  });
});

describe("enumeratePeriodKeys", () => {
  it("fills day keys across a window", () => {
    const since = Date.parse("2026-11-16T00:00:00Z");
    const until = Date.parse("2026-11-18T12:00:00Z");
    const keys = enumeratePeriodKeys(since, until, "day", "UTC");
    expect(keys).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
  });
});

describe("bucketPeriodKey", () => {
  it("joins day and hour for hourly views", () => {
    expect(bucketPeriodKey({ day: "2026-11-18", hour: 6 }, "hour")).toBe("2026-11-18T06");
    expect(bucketPeriodKey({ day: "2026-11-18" }, "day")).toBe("2026-11-18");
  });
});
