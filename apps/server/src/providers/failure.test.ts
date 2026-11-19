import { describe, expect, it } from "vitest";
import { classifyGenericText, parseResetAt, parseRetryAfter } from "./failure.ts";

const NOW = new Date("2026-11-18T15:00:00.000Z");

describe("parseRetryAfter", () => {
  it.each([
    ["60", 60_000],
    [" 120 ", 120_000],
    ["Retry-After: 8", 8_000],
    ["HTTP/1.1 429 Too Many Requests\nRetry-After: 30", 30_000],
  ])("%j → %d ms", (text, expected) => {
    expect(parseRetryAfter(text, NOW)).toBe(expected);
  });

  it("parses an HTTP-date Retry-After against the injected clock", () => {
    const text = "Retry-After: Wed, 18 Nov 2026 16:00:00 GMT";
    expect(parseRetryAfter(text, NOW)).toBe(60 * 60 * 1000);
  });

  it("returns undefined when the value is not a delay", () => {
    expect(parseRetryAfter("tool crashed", NOW)).toBeUndefined();
    expect(parseRetryAfter("429 Too Many Requests", NOW)).toBeUndefined();
  });
});

describe("parseResetAt", () => {
  it("reads an ISO timestamp", () => {
    expect(parseResetAt("resets at 2026-11-18T20:00:00.000Z", NOW)).toBe(
      "2026-11-18T20:00:00.000Z",
    );
  });

  it("reads a pipe-delimited unix epoch from a Claude usage-limit line", () => {
    expect(parseResetAt("Claude AI usage limit reached|1763485200", NOW)).toBe(
      new Date(1_763_485_200 * 1000).toISOString(),
    );
  });

  it("adds a relative delay from now", () => {
    expect(parseResetAt("try again in 2 hours", NOW)).toBe("2026-11-18T17:00:00.000Z");
    expect(parseResetAt("reset in 37 minutes", NOW)).toBe("2026-11-18T15:37:00.000Z");
    expect(parseResetAt("retry in 30s", NOW)).toBe("2026-11-18T15:00:30.000Z");
  });

  it("parses a local wall clock later today", () => {
    const morning = new Date(2026, 10, 18, 10, 0, 0);
    expect(parseResetAt("resets at 3pm", morning)).toBe(
      new Date(2026, 10, 18, 15, 0, 0).toISOString(),
    );
    expect(parseResetAt("try again at 3:00 PM", morning)).toBe(
      new Date(2026, 10, 18, 15, 0, 0).toISOString(),
    );
  });

  it("rolls a past wall clock to the next day", () => {
    const evening = new Date(2026, 10, 18, 16, 0, 0);
    expect(parseResetAt("resets at 3pm", evening)).toBe(
      new Date(2026, 10, 19, 15, 0, 0).toISOString(),
    );
  });

  it("returns undefined when no reset time is present", () => {
    expect(parseResetAt("tool crashed after 12 attempts", NOW)).toBeUndefined();
  });
});

describe("classifyGenericText", () => {
  it.each([
    {
      name: "429 Too Many Requests with Retry-After",
      text: "HTTP/1.1 429 Too Many Requests\nRetry-After: 8",
      kind: "rate_limit" as const,
      retryAfterMs: 8_000,
    },
    {
      name: "rate limit phrase",
      text: "API Error: rate_limit_error This request would exceed the rate limit",
      kind: "rate_limit" as const,
    },
    {
      name: "too many requests",
      text: "too many requests, slow down",
      kind: "rate_limit" as const,
    },
    {
      name: "usage limit",
      text: "You've hit your usage limit. Upgrade to Pro or try again at 3:00 PM",
      kind: "quota" as const,
    },
    {
      name: "quota",
      text: "You have exceeded your quota for this model",
      kind: "quota" as const,
    },
    {
      name: "credit balance",
      text: "Your credit balance is too low to complete this request",
      kind: "quota" as const,
    },
    {
      name: "billing error",
      text: "billing_error: add billing to continue",
      kind: "quota" as const,
    },
    {
      name: "overloaded",
      text: "API Error: overloaded",
      kind: "overloaded" as const,
    },
    {
      name: "529",
      text: "API Error: 529 Overloaded",
      kind: "overloaded" as const,
    },
    {
      name: "503",
      text: "503 Service Unavailable",
      kind: "overloaded" as const,
    },
    {
      name: "401",
      text: "401 Unauthorized",
      kind: "auth" as const,
    },
    {
      name: "not logged in",
      text: "Not logged in",
      kind: "auth" as const,
    },
    {
      name: "invalid api key",
      text: "invalid api key",
      kind: "auth" as const,
    },
  ])("$name", ({ text, kind, retryAfterMs }) => {
    const morning = new Date(2026, 10, 18, 10, 0, 0);
    expect(classifyGenericText(text, morning)).toMatchObject({
      kind,
      message: text,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  });

  it("fills resetAt from try again at 3:00 PM", () => {
    const morning = new Date(2026, 10, 18, 10, 0, 0);
    const got = classifyGenericText(
      "You've hit your usage limit. Upgrade to Pro or try again at 3:00 PM",
      morning,
    );
    expect(got).toMatchObject({
      kind: "quota",
      resetAt: new Date(2026, 10, 18, 15, 0, 0).toISOString(),
    });
  });

  it.each([
    ["I'll add a rate limiter in billing.ts next"],
    ["The quota of the helper is 12 items"],
    ["Read src/billing.ts and add retries"],
    ["Tool crashed after 12 attempts"],
    ["The turn was interrupted."],
    ["user aborted"],
    ["Process exited on signal SIGTERM; interrupted"],
    [""],
  ])("returns null for %j", (text) => {
    expect(classifyGenericText(text, NOW)).toBeNull();
  });
});
