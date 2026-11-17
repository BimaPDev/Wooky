import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./adapter.ts";
import { isAuthFailure, parseAuthFromStatus, parseModelsFromList } from "./probe.ts";

describe("parseAuthFromStatus", () => {
  it("detects logged in", () => {
    expect(parseAuthFromStatus("✓ Logged in as user@example.com")).toBe(true);
  });

  it("detects login required", () => {
    expect(parseAuthFromStatus("Authentication is required. Run cursor-agent login.")).toBe(false);
  });

  it("returns null for ambiguous output", () => {
    expect(parseAuthFromStatus("cursor-agent status")).toBeNull();
  });
});

describe("parseModelsFromList", () => {
  it("parses id - Label lines", () => {
    const out = parseModelsFromList(
      `Available models\n\nauto - Auto (current)\ngpt-test - GPT Test\n`,
    );
    expect(out).toEqual([
      { id: "auto", label: "Auto (current)" },
      { id: "gpt-test", label: "GPT Test" },
    ]);
  });
});

describe("probe with nonexistent binary", () => {
  it("reports installed false", async () => {
    const adapter = createCursorAdapter({
      cursorBin: "/nonexistent/cursor-agent-missing",
    });
    const status = await adapter.probe();
    expect(status.installed).toBe(false);
    expect(status.problem).toMatch(/not installed/i);
  });

  it("does not mistake 'not logged in' for a login", () => {
    expect(parseAuthFromStatus("You are not logged in.")).toBe(false);
    expect(parseAuthFromStatus("Not signed in")).toBe(false);
  });

  it("recognises the CLI's sign-in refusal", () => {
    expect(
      isAuthFailure(
        "Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY.",
      ),
    ).toBe(true);
    expect(isAuthFailure("auto - Auto (current, default)")).toBe(false);
  });
});
