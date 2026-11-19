import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { classifyClaudeFailure } from "./classify.ts";

const NOW = new Date("2026-11-18T15:00:00.000Z");

describe("classifyClaudeFailure", () => {
  it.each([
    {
      name: "Claude AI usage limit with epoch reset",
      input: { errorText: "Claude AI usage limit reached|1763485200" },
      kind: "quota" as const,
      resetAt: new Date(1_763_485_200 * 1000).toISOString(),
    },
    {
      name: "Pro usage limit with local reset time",
      input: {
        errorText: "You've hit your usage limit. Upgrade to Pro or try again at 3:00 PM",
        now: new Date(2026, 10, 18, 10, 0, 0),
      },
      kind: "quota" as const,
      resetAt: new Date(2026, 10, 18, 15, 0, 0).toISOString(),
    },
    {
      name: "429 Too Many Requests with Retry-After",
      input: {
        apiStatus: 429,
        errorText: "429 Too Many Requests\nRetry-After: 8",
      },
      kind: "rate_limit" as const,
      retryAfterMs: 8_000,
    },
    {
      name: "Overloaded 529",
      input: { apiStatus: 529, errorText: "API Error: 529 Overloaded" },
      kind: "overloaded" as const,
    },
    {
      name: "success is_error overloaded text",
      input: { resultSubtype: "success", errorText: "API Error: overloaded" },
      kind: "overloaded" as const,
    },
    {
      name: "error_max_budget_usd",
      input: { resultSubtype: "error_max_budget_usd" },
      kind: "quota" as const,
    },
    {
      name: "authentication_failed result text",
      input: { errorText: "Not logged in" },
      kind: "auth" as const,
    },
    {
      name: "HTTP 401",
      input: { apiStatus: 401, errorText: "authentication_failed" },
      kind: "auth" as const,
    },
  ])("$name", ({ input, kind, resetAt, retryAfterMs }) => {
    expect(classifyClaudeFailure({ now: NOW, ...input })).toMatchObject({
      kind,
      ...(resetAt ? { resetAt } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  });

  it("classifies a rejected five_hour rate_limit_event as quota", () => {
    const rateLimit: SDKRateLimitInfo = {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 100,
      resetsAt: 1_763_485_200,
    };
    expect(classifyClaudeFailure({ rateLimit, now: NOW })).toEqual({
      kind: "quota",
      message: "Claude AI usage limit reached",
      resetAt: new Date(1_763_485_200 * 1000).toISOString(),
      retryAfterMs: Math.max(0, 1_763_485_200 * 1000 - NOW.getTime()),
    });
  });

  it("classifies credits_required on a rate_limit_event as quota", () => {
    const rateLimit: SDKRateLimitInfo = {
      status: "rejected",
      errorCode: "credits_required",
      overageDisabledReason: "out_of_credits",
    };
    expect(classifyClaudeFailure({ rateLimit, errorText: "out of credits", now: NOW })?.kind).toBe(
      "quota",
    );
  });

  it("ignores an allowed_warning rate_limit_event without error text", () => {
    const rateLimit: SDKRateLimitInfo = {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 88,
      resetsAt: 1_764_000_000,
    };
    expect(classifyClaudeFailure({ rateLimit, now: NOW })).toBeNull();
  });

  it.each([
    [{ resultSubtype: "error_max_turns" }],
    [{ resultSubtype: "error_max_structured_output_retries" }],
    [{ resultSubtype: "error_during_execution", errorText: "Tool crashed" }],
    [{ errorText: "The turn was interrupted." }],
    [{ errorText: "Claude Code stopped before finishing the turn." }],
    [{}],
  ])("returns null for %j", (input) => {
    expect(classifyClaudeFailure({ now: NOW, ...input })).toBeNull();
  });
});
