import type { UsageHistoryBucket, UsageHistorySource } from "@age/contracts";
import { describe, expect, it } from "vitest";
import { buildUsageDashboardStats } from "./usage-stats.ts";

const bucket = (
  fields: Partial<UsageHistoryBucket> & Pick<UsageHistoryBucket, "origin" | "model">,
) => ({
  day: "2026-11-18",
  inputTokens: 100,
  cacheReadTokens: 40,
  cacheWriteTokens: 10,
  outputTokens: 20,
  costUsd: 1,
  costByType: { input: 0.2, cacheRead: 0.5, cacheWrite: 0.1, output: 0.15, other: 0.05 },
  cacheSavingsUsd: 0.08,
  records: 1,
  unpricedRecords: 0,
  ...fields,
});

const source = (
  fields: Partial<UsageHistorySource> & Pick<UsageHistorySource, "origin" | "status">,
) => ({
  files: 1,
  distinctSessions: 7,
  refreshing: false,
  ...fields,
});

describe("buildUsageDashboardStats", () => {
  it("uses distinctSessions instead of bucket sessions", () => {
    const stats = buildUsageDashboardStats({
      buckets: [bucket({ origin: "claude", model: "claude-opus-4-6" })],
      sources: [source({ origin: "claude", status: "ok" })],
      turnRows: [],
      windowDays: 30,
      timeZone: "UTC",
      nowMs: Date.parse("2026-11-18T18:00:00Z"),
      hiddenSeries: new Set(),
    });
    expect(stats.providers[0]?.sessions).toBe(7);
    expect(stats.cacheWrite).toBe(10);
    expect(stats.costByType.input).toBe(0.2);
  });

  it("counts demo turns as sessions", () => {
    const stats = buildUsageDashboardStats({
      buckets: [],
      sources: [source({ origin: "claude", status: "failed" })],
      turnRows: [
        {
          id: "a",
          provider: "demo",
          model: "demo",
          startedAt: "2026-11-18T10:00:00.000Z",
          endedAt: "2026-11-18T10:01:00.000Z",
          usage: { inputTokens: 5, outputTokens: 5, costUsd: 0 },
        },
      ],
      windowDays: 30,
      timeZone: "UTC",
      nowMs: Date.parse("2026-11-18T18:00:00Z"),
      hiddenSeries: new Set(),
    });
    const demo = stats.providers.find((row) => row.id === "demo");
    expect(demo?.sessions).toBe(1);
  });
});
