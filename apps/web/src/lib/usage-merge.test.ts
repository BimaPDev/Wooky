import type { Turn, UsageHistorySource } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import {
  collectTurnRows,
  filterHistoryBuckets,
  providerForOrigin,
  turnProvidersFromSources,
  usesImportedHistory,
} from "./usage-merge.ts";

const source = (
  fields: Partial<UsageHistorySource> & Pick<UsageHistorySource, "origin" | "status">,
) => ({
  files: 1,
  distinctSessions: 2,
  refreshing: false,
  ...fields,
});

describe("usesImportedHistory", () => {
  it("treats ok and partial as imported", () => {
    expect(usesImportedHistory("ok")).toBe(true);
    expect(usesImportedHistory("partial")).toBe(true);
    expect(usesImportedHistory("missing")).toBe(false);
    expect(usesImportedHistory("disabled")).toBe(false);
    expect(usesImportedHistory("failed")).toBe(false);
  });
});

describe("turnProvidersFromSources", () => {
  it("always keeps demo on turns", () => {
    const providers = turnProvidersFromSources([
      source({ origin: "claude", status: "ok" }),
      source({ origin: "cursor", status: "partial" }),
    ]);
    expect([...providers]).toEqual(["demo"]);
  });

  it("falls back to turns when import failed", () => {
    const providers = turnProvidersFromSources([
      source({ origin: "claude", status: "failed" }),
      source({ origin: "codex", status: "missing" }),
    ]);
    expect([...providers].toSorted()).toEqual(["claude", "codex", "demo"]);
  });
});

describe("filterHistoryBuckets", () => {
  it("drops buckets for origins that did not import", () => {
    const buckets = [
      {
        day: "2026-11-18",
        origin: "claude" as const,
        model: "claude-opus-4-6",
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costUsd: 0.1,
        costByType: { input: 0.1, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
        cacheSavingsUsd: 0,
        records: 1,
        unpricedRecords: 0,
      },
      {
        day: "2026-11-18",
        origin: "cursor" as const,
        model: "default",
        inputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costUsd: 0.2,
        costByType: { input: 0.2, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
        cacheSavingsUsd: 0,
        records: 1,
        unpricedRecords: 0,
      },
    ];
    const kept = filterHistoryBuckets(buckets, [source({ origin: "claude", status: "ok" })]);
    expect(kept.map((b) => b.origin)).toEqual(["claude"]);
  });
});

describe("collectTurnRows", () => {
  it("skips providers satisfied by import", () => {
    const turn: Turn = {
      id: "t1",
      threadId: "th1",
      provider: "claude",
      model: "claude-opus-4-6",
      status: "completed",
      items: [],
      prompt: "hi",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      checkpointBefore: null,
      checkpointAfter: null,
      changedFiles: [],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      error: null,
    };
    const rows = collectTurnRows({ th1: [turn] }, new Set(["demo"]));
    expect(rows).toHaveLength(0);
  });
});

describe("providerForOrigin", () => {
  it("maps opencode to no provider kind", () => {
    expect(providerForOrigin("opencode")).toBeNull();
    expect(providerForOrigin("antigravity")).toBeNull();
    expect(providerForOrigin("claude")).toBe("claude");
  });
});
