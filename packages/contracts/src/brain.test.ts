import { describe, expect, it } from "vitest";
import {
  BrainEntry,
  BrainScope,
  BrainSearchHit,
  BrainTreeNode,
  BrainUri,
  MemoryFrontmatter,
  MemoryFrontmatterInput,
  brainScopeKey,
  brainTrust,
  formatBrainUri,
  isBrainMemoryPath,
  parseBrainPath,
  parseBrainUri,
} from "./brain.ts";

const at = "2026-01-01T00:00:00.000Z";
const frontmatter = {
  summary: "Use pnpm, never npm",
  kind: "preference",
  tags: ["tooling"],
  status: "active",
  updatedAt: at,
} as const;

describe("brain URIs", () => {
  it("round-trips global and project URIs", () => {
    const cases = [
      "brain://global/",
      "brain://global/prefs.md",
      "brain://global/lessons/git/rebase.md",
      "brain://global/lessons",
      "brain://project/project_1/",
      "brain://project/project_1/decisions/db.md",
    ];
    for (const uri of cases) {
      const parsed = parseBrainUri(uri);
      expect(parsed).not.toBeNull();
      if (parsed === null) continue;
      expect(formatBrainUri(parsed.scope, parsed.path)).toBe(uri);
      expect(BrainUri.safeParse(uri).success).toBe(true);
    }
  });

  it("reads the scope and path", () => {
    expect(parseBrainUri("brain://project/p-1/a/b.md")).toEqual({
      scope: { kind: "project", projectId: "p-1" },
      path: "a/b.md",
      segments: ["a", "b.md"],
    });
    expect(parseBrainUri("brain://global")?.path).toBe("");
    expect(parseBrainUri("brain://global/lessons/")?.path).toBe("lessons");
  });

  it("rejects anything that is not a plain lowercase relative path", () => {
    const bad = [
      "brain://global/../x.md",
      "brain://global/a/../x.md",
      "brain://global/./x.md",
      "brain://global//x.md",
      "brain://global/a//x.md",
      "brain://global/%2e%2e/x.md",
      "brain://global/a%2fb.md",
      "brain://global/a%00.md",
      "brain://global/a\\b.md",
      "brain://global/a\0b.md",
      "brain://global/A.md",
      "brain://global/.hidden.md",
      "brain://global/trailing-dot./x.md",
      "brain://global/nul.md",
      "brain://global/a b.md",
      "brain://global/a/b/c/d/e/f/g.md",
      "brain://global/notes.md/inner.md",
      "brain://project/x.md",
      "brain://project/a%2Fb/x.md",
      "brain://project/../x.md",
      "brain://other/x.md",
      "file:///etc/passwd",
      "global/x.md",
      "",
    ];
    for (const uri of bad) expect(parseBrainUri(uri)).toBeNull();
  });

  it("allows six segments and no more", () => {
    expect(parseBrainPath("a/b/c/d/e/f.md")).toHaveLength(6);
    expect(parseBrainPath("a/b/c/d/e/f/g.md")).toBeNull();
  });

  it("keeps _overview.md out of the segment grammar", () => {
    expect(parseBrainPath("lessons/_overview.md")).toBeNull();
  });

  it("tells memories from folders by the .md suffix", () => {
    expect(isBrainMemoryPath("a/b.md")).toBe(true);
    expect(isBrainMemoryPath("a/b")).toBe(false);
    expect(isBrainMemoryPath("")).toBe(false);
  });

  it("derives trust and index keys from the scope", () => {
    expect(brainTrust({ kind: "global" })).toBe("user");
    expect(brainTrust({ kind: "project", projectId: "p" })).toBe("repo");
    expect(brainScopeKey({ kind: "global" })).toBe("global");
    expect(brainScopeKey({ kind: "project", projectId: "p" })).toBe("project:p");
    expect(BrainScope.safeParse({ kind: "project", projectId: "../x" }).success).toBe(false);
  });
});

describe("memory frontmatter", () => {
  it("accepts a complete record", () => {
    const parsed = MemoryFrontmatter.parse({
      ...frontmatter,
      pinned: true,
      source: { threadId: "t1", turnId: "u1", fleetRunId: "f1", agent: "claude", at },
    });
    expect(parsed.source?.agent).toBe("claude");
  });

  it("limits the summary to 200 characters on one line", () => {
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, summary: "x".repeat(200) }).success).toBe(
      true,
    );
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, summary: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, summary: "a\nb" }).success).toBe(false);
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, summary: "" }).success).toBe(false);
  });

  it("rejects unknown fields, kinds and statuses", () => {
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, extra: 1 }).success).toBe(false);
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, kind: "rant" }).success).toBe(false);
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, status: "deleted" }).success).toBe(false);
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, source: { oops: 1 } }).success).toBe(
      false,
    );
    expect(MemoryFrontmatter.safeParse({ ...frontmatter, updatedAt: "yesterday" }).success).toBe(
      false,
    );
  });

  it("fills tags and status for writers, and never lets them set updatedAt", () => {
    const input = MemoryFrontmatterInput.parse({ summary: "s", kind: "note" });
    expect(input).toMatchObject({ tags: [], status: "active" });
    expect(
      MemoryFrontmatterInput.safeParse({ summary: "s", kind: "note", updatedAt: at }).success,
    ).toBe(false);
  });
});

describe("brain results", () => {
  const scope = { kind: "project", projectId: "p1" } as const;
  const uri = "brain://project/p1/a.md";

  it("every result type carries trust", () => {
    expect(
      BrainEntry.parse({
        uri,
        scope,
        path: "a.md",
        type: "memory",
        trust: "repo",
        tier: 2,
        frontmatter,
        body: "text",
      }).trust,
    ).toBe("repo");
    expect(
      BrainSearchHit.parse({
        uri,
        scope,
        path: "a.md",
        trust: "repo",
        summary: "s",
        kind: "note",
        tags: [],
        status: "active",
        updatedAt: at,
        score: 1.5,
      }).trust,
    ).toBe("repo");
    expect(
      BrainTreeNode.parse({ uri, scope, path: "a.md", name: "a.md", type: "memory", trust: "repo" })
        .trust,
    ).toBe("repo");
    expect(
      BrainTreeNode.safeParse({ uri, scope, path: "a.md", name: "a.md", type: "memory" }).success,
    ).toBe(false);
  });
});
