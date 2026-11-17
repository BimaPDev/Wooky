import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./adapter.ts";
import { parseAuthFromStatus, parseModelsFromList } from "./probe.ts";

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
});
