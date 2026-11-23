import { describe, expect, it } from "vitest";
import type { MemoryFrontmatter } from "@wooky/contracts";
import { effectiveTrust, isAgentAuthored } from "./trust.ts";

const base: MemoryFrontmatter = {
  summary: "s",
  kind: "note",
  tags: [],
  status: "active",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("isAgentAuthored", () => {
  it("is true when the memory carries an agent source", () => {
    expect(isAgentAuthored({ ...base, source: { threadId: "t1" } })).toBe(true);
    expect(isAgentAuthored({ ...base, source: { agent: "claude" } })).toBe(true);
    expect(isAgentAuthored({ ...base, source: { fleetRunId: "f1" } })).toBe(true);
    expect(isAgentAuthored({ ...base, source: { turnId: "u1" } })).toBe(true);
  });

  it("is false without a source or with only a timestamp", () => {
    expect(isAgentAuthored(base)).toBe(false);
    expect(isAgentAuthored({ ...base, source: {} })).toBe(false);
    expect(isAgentAuthored({ ...base, source: { at: "2026-01-01T00:00:00.000Z" } })).toBe(false);
  });
});

describe("effectiveTrust", () => {
  it("keeps repo as repo and downgrades an agent-authored global memory to repo", () => {
    expect(effectiveTrust({ trust: "repo", frontmatter: base })).toBe("repo");
    expect(effectiveTrust({ trust: "user", frontmatter: base })).toBe("user");
    expect(
      effectiveTrust({ trust: "user", frontmatter: { ...base, source: { threadId: "t" } } }),
    ).toBe("repo");
  });
});
