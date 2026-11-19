import type { ReviewNote } from "@age/contracts";
import { describe, expect, it } from "vitest";
import { claimSnippets, isStale, snippetOf, SNIPPET_MAX, type PendingSnippet } from "./snippets.ts";

const note = (id: string, threadId: string, path: string, line: number): ReviewNote => ({
  id,
  threadId,
  path,
  line,
  side: "new",
  body: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("snippetOf", () => {
  it("collapses whitespace so a re-indented line keeps its snippet", () => {
    expect(snippetOf("    return   db.orders\t.findMany();  ")).toBe(
      "return db.orders .findMany();",
    );
  });

  it("caps long lines", () => {
    expect(snippetOf("x".repeat(500))).toHaveLength(SNIPPET_MAX);
  });
});

describe("isStale", () => {
  it("never flags a note whose snippet is unknown", () => {
    expect(isStale(undefined, "anything")).toBe(false);
    expect(isStale(undefined, null)).toBe(false);
  });

  it("flags a note whose line text changed", () => {
    expect(isStale(snippetOf("return a;"), "return b;")).toBe(true);
  });

  it("keeps a note whose line text is unchanged, ignoring indentation", () => {
    expect(isStale(snippetOf("return a;"), "   return a;")).toBe(false);
  });

  it("flags a note whose line is no longer in the diff", () => {
    expect(isStale(snippetOf("return a;"), null)).toBe(true);
  });
});

describe("claimSnippets", () => {
  const pending: PendingSnippet[] = [
    { threadId: "t1", key: '["a.ts","new",5]', snippet: "take: limit," },
  ];

  it("gives a newly appeared note the snippet its anchor was added with", () => {
    const after = { t1: [note("n1", "t1", "a.ts", 5)] };
    const result = claimSnippets(pending, {}, after);
    expect(result.claimed).toEqual({ n1: "take: limit," });
    expect(result.pending).toEqual([]);
  });

  it("ignores notes that were already there", () => {
    const before = { t1: [note("n0", "t1", "a.ts", 5)] };
    const result = claimSnippets(pending, before, before);
    expect(result.claimed).toEqual({});
    expect(result.pending).toEqual(pending);
  });

  it("does not match a note on another thread or another line", () => {
    const after = { t2: [note("n1", "t2", "a.ts", 5)], t1: [note("n2", "t1", "a.ts", 6)] };
    const result = claimSnippets(pending, {}, after);
    expect(result.claimed).toEqual({});
    expect(result.pending).toEqual(pending);
  });

  it("lets one pending entry claim only one note", () => {
    const after = { t1: [note("n1", "t1", "a.ts", 5), note("n2", "t1", "a.ts", 5)] };
    const result = claimSnippets(pending, {}, after);
    expect(Object.keys(result.claimed)).toEqual(["n1"]);
  });
});
