import { describe, expect, it } from "vitest";
import {
  labelFromWindowDurationMins,
  normalizeCodexRateLimits,
  type CodexRateLimitsReadResponse,
} from "./limits.ts";

const checkedAt = "2026-11-17T12:00:00.000Z";

describe("labelFromWindowDurationMins", () => {
  it("maps known durations and falls back to hours", () => {
    expect(labelFromWindowDurationMins(300)).toBe("5-hour");
    expect(labelFromWindowDurationMins(10_080)).toBe("Weekly");
    expect(labelFromWindowDurationMins(90)).toBe("2h");
    expect(labelFromWindowDurationMins(null)).toBe("Window");
  });
});

describe("normalizeCodexRateLimits", () => {
  it("maps primary and secondary windows with plan type", () => {
    const raw: CodexRateLimitsReadResponse = {
      rateLimits: {
        primary: {
          usedPercent: 33,
          windowDurationMins: 300,
          resetsAt: 1_764_000_000,
        },
        secondary: {
          usedPercent: 70,
          windowDurationMins: 10_080,
          resetsAt: 1_764_500_000,
        },
        planType: "plus",
      },
    };

    expect(normalizeCodexRateLimits(raw, checkedAt)).toEqual({
      provider: "codex",
      available: true,
      plan: "plus",
      windows: [
        {
          id: "primary",
          label: "5-hour",
          usedPercent: 33,
          resetsAt: new Date(1_764_000_000 * 1000).toISOString(),
        },
        {
          id: "secondary",
          label: "Weekly",
          usedPercent: 70,
          resetsAt: new Date(1_764_500_000 * 1000).toISOString(),
        },
      ],
      checkedAt,
      problem: null,
    });
  });

  it("tolerates a missing secondary window", () => {
    const raw: CodexRateLimitsReadResponse = {
      rateLimits: {
        primary: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
        planType: "pro",
      },
    };

    expect(normalizeCodexRateLimits(raw, checkedAt).windows).toEqual([
      {
        id: "primary",
        label: "5-hour",
        usedPercent: 12,
        resetsAt: null,
      },
    ]);
  });
});
