import { describe, expect, it } from "vitest";
import { redactCliError } from "./redact.ts";

describe("redactCliError", () => {
  it("strips URL userinfo and github tokens", () => {
    const raw = "fatal: https://x-access-token:ghs_secret123@127.0.0.1:1/r.git denied";
    const redacted = redactCliError(raw);
    expect(redacted).not.toContain("ghs_secret123");
    expect(redacted).not.toContain("x-access-token");
    expect(redacted).toContain("https://127.0.0.1:1/r.git");
  });
});
