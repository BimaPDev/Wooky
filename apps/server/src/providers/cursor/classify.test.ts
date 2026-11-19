import { describe, expect, it } from "vitest";
import { classifyCursorFailure } from "./classify.ts";

const NOW = new Date("2026-11-18T15:00:00.000Z");

describe("classifyCursorFailure", () => {
  it.each([
    {
      name: "usage limit for a named model",
      input: { errorText: "You've reached your usage limit for composer-2" },
      kind: "quota" as const,
    },
    {
      name: "429 on a result line",
      input: { errorText: "429 Too Many Requests", stderr: "Retry-After: 15" },
      kind: "rate_limit" as const,
      retryAfterMs: 15_000,
    },
    {
      name: "overloaded on stderr",
      input: { stderr: "API Error: 529 Overloaded" },
      kind: "overloaded" as const,
    },
    {
      name: "CLI auth refusal",
      input: {
        errorText:
          "Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY.",
      },
      kind: "auth" as const,
    },
    {
      name: "not logged in on stderr",
      input: { stderr: "You are not logged in." },
      kind: "auth" as const,
    },
  ])("$name", ({ input, kind, retryAfterMs }) => {
    expect(classifyCursorFailure({ now: NOW, ...input })).toMatchObject({
      kind,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  });

  it.each([
    [{ errorText: "Something went wrong" }],
    [{ errorText: "Translation failed" }],
    [{ stderr: "simulated crash", exitCode: 1 }],
    [{ exitCode: 130, errorText: "You've reached your usage limit for auto" }],
    [{ exitCode: 143 }],
    [{ errorText: "The turn was interrupted." }],
    [{ errorText: "I'll add a rate limiter in billing.ts" }],
    [{}],
  ])("returns null for %j", (input) => {
    expect(classifyCursorFailure({ now: NOW, ...input })).toBeNull();
  });
});
