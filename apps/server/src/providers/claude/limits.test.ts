import { describe, expect, it } from "vitest";
import { applyClaudeRateLimitEvent, normalizeClaudeUsage, type ClaudeUsageRaw } from "./limits.ts";

const checkedAt = "2026-11-17T12:00:00.000Z";

describe("normalizeClaudeUsage", () => {
  it("maps named windows, model_scoped, and skips null-only windows", () => {
    const raw: ClaudeUsageRaw = {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-11-17T17:00:00.000Z" },
        seven_day: { utilization: null, resets_at: null },
        seven_day_opus: { utilization: 10, resets_at: null },
        seven_day_sonnet: null,
        model_scoped: [
          { display_name: "Fable", utilization: 5, resets_at: "2026-11-20T00:00:00.000Z" },
          { display_name: "Empty", utilization: null, resets_at: null },
        ],
      },
    };

    expect(normalizeClaudeUsage(raw, checkedAt)).toEqual({
      provider: "claude",
      available: true,
      plan: "max",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          usedPercent: 42,
          resetsAt: "2026-11-17T17:00:00.000Z",
        },
        {
          id: "seven_day_opus",
          label: "Weekly · Opus",
          usedPercent: 10,
          resetsAt: null,
        },
        {
          id: "model_scoped:Fable",
          label: "Weekly · Fable",
          usedPercent: 5,
          resetsAt: "2026-11-20T00:00:00.000Z",
        },
      ],
      checkedAt,
      problem: null,
    });
  });

  it("returns unavailable when rate limits are missing", () => {
    expect(
      normalizeClaudeUsage(
        {
          subscription_type: null,
          rate_limits_available: false,
          rate_limits: null,
        },
        checkedAt,
      ),
    ).toMatchObject({
      provider: "claude",
      available: false,
      plan: null,
      windows: [],
      problem: "Claude plan limits are not available for this account.",
    });
  });
});

describe("applyClaudeRateLimitEvent", () => {
  it("updates the matching window from a rate_limit_event", () => {
    const base = normalizeClaudeUsage(
      {
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 10, resets_at: "2026-11-17T14:00:00.000Z" },
          seven_day: { utilization: 20, resets_at: "2026-11-24T00:00:00.000Z" },
        },
      },
      checkedAt,
    );

    const next = applyClaudeRateLimitEvent(
      base,
      {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 88,
        resetsAt: 1_764_000_000,
      },
      "2026-11-17T12:30:00.000Z",
    );

    expect(next.windows.find((window) => window.id === "five_hour")).toEqual({
      id: "five_hour",
      label: "5-hour",
      usedPercent: 88,
      resetsAt: new Date(1_764_000_000 * 1000).toISOString(),
    });
    expect(next.windows.find((window) => window.id === "seven_day")?.usedPercent).toBe(20);
  });
});
