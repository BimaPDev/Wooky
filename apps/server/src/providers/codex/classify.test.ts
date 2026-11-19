import { describe, expect, it } from "vitest";
import { classifyCodexFailure } from "./classify.ts";
import { JsonRpcRemoteError } from "./jsonrpc.ts";

const NOW = new Date("2026-11-18T15:00:00.000Z");

describe("classifyCodexFailure", () => {
  it("classifies usage_limit_reached with resets_in_seconds", () => {
    const error = new JsonRpcRemoteError({
      code: -32000,
      message: "usage_limit_reached",
      data: { code: "usage_limit_reached", resets_in_seconds: 832, plan_type: "plus" },
    });
    const got = classifyCodexFailure({ error, now: NOW });
    expect(got).toEqual({
      kind: "quota",
      message: "usage_limit_reached",
      retryAfterMs: 832_000,
      resetAt: new Date(NOW.getTime() + 832_000).toISOString(),
    });
  });

  it("classifies a 429 JSON-RPC error", () => {
    const error = new JsonRpcRemoteError({
      code: 429,
      message: "Too Many Requests",
      data: { status: 429 },
    });
    expect(classifyCodexFailure({ error, now: NOW })).toMatchObject({
      kind: "rate_limit",
      message: "Too Many Requests",
    });
  });

  it("classifies an upstream rate-limit notification", () => {
    const got = classifyCodexFailure({
      errorText: "Upstream rate limit: retry in 30s",
      now: NOW,
    });
    expect(got).toMatchObject({
      kind: "rate_limit",
      resetAt: "2026-11-18T15:00:30.000Z",
      retryAfterMs: 30_000,
    });
  });

  it("classifies overloaded and auth from text", () => {
    expect(classifyCodexFailure({ errorText: "API Error: 529 Overloaded", now: NOW })?.kind).toBe(
      "overloaded",
    );
    expect(classifyCodexFailure({ errorText: "invalid api key", now: NOW })?.kind).toBe("auth");
  });

  it("reads usage_limit_reached off a plain error record", () => {
    const got = classifyCodexFailure({
      error: {
        code: -32000,
        message: "You've hit your usage limit",
        data: { code: "usage_limit_reached", resets_in_seconds: 60 },
      },
      now: NOW,
    });
    expect(got).toMatchObject({ kind: "quota", retryAfterMs: 60_000 });
  });

  it.each([
    [{ errorText: "Codex turn failed." }],
    [{ error: new JsonRpcRemoteError({ code: -32600, message: "Already initialized" }) }],
    [{ error: new JsonRpcRemoteError({ code: -32601, message: "Unknown method: account/read" }) }],
    [{ errorText: "The turn was interrupted." }],
    [{ errorText: "Tool crashed after 12 attempts" }],
    [{}],
  ])("returns null for ordinary errors %j", (input) => {
    expect(classifyCodexFailure({ now: NOW, ...input })).toBeNull();
  });
});
