import {
  DeviceSettings,
  RpcMethods,
  UsageHistoryParams,
  UsageHistoryResult,
  type UsageHistoryBucket,
  type UsageHistoryResult as UsageHistory,
} from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import {
  ImportTuning,
  type HistoryFs,
  type HistoryReader,
  type HistoryReaderContext,
  type HistoryRecord,
  type HistorySourceReport,
  type HistoryStat,
} from "./history-reader.ts";

const costByType = { input: 0.2, cacheRead: 0.02, cacheWrite: 0.05, output: 0.15, other: 0 };

const bucket: UsageHistoryBucket = {
  day: "2026-11-18",
  hour: 6,
  origin: "claude",
  model: "claude-opus-4-6",
  inputTokens: 100,
  cacheReadTokens: 40,
  cacheWriteTokens: 10,
  outputTokens: 20,
  reasoningTokens: 5,
  costUsd: 0.42,
  costByType,
  cacheSavingsUsd: 0.08,
  records: 3,
  unpricedRecords: 0,
};

const dailyBucket: UsageHistoryBucket = {
  day: "2026-11-17",
  origin: "opencode",
  model: "opencode-go/gpt-5",
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
  cacheSavingsUsd: 0,
  records: 0,
  unpricedRecords: 1,
};

const result: UsageHistory = {
  version: 1,
  buckets: [bucket, dailyBucket],
  sources: [
    {
      origin: "claude",
      status: "partial",
      files: 2,
      distinctSessions: 1,
      refreshing: true,
      note: "One file could not be read.",
    },
    {
      origin: "opencode",
      status: "ok",
      files: 1,
      distinctSessions: 1,
      refreshing: false,
    },
  ],
  pricing: { status: "stale", asOf: "2026-11-18T00:00:00.000Z" },
  generatedAt: "2026-11-18T06:26:00.000Z",
};

describe("usage.history contract", () => {
  it("round-trips params", () => {
    const params = {
      windowDays: 1 as const,
      timeZone: "America/New_York",
      origins: ["claude", "cursor", "codex", "opencode"] as const,
      awaitRefresh: true,
    };
    const parsed = UsageHistoryParams.parse(params);
    expect(parsed).toEqual(params);
    expect(UsageHistoryParams.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(RpcMethods["usage.history"].params.parse(params)).toEqual(parsed);
  });

  it("accepts each window and an omitted filter", () => {
    for (const windowDays of [1, 7, 30, 90]) {
      expect(UsageHistoryParams.parse({ windowDays, timeZone: "UTC" })).toEqual({
        windowDays,
        timeZone: "UTC",
      });
    }
  });

  it("rejects invalid params", () => {
    const bad = [
      {},
      { windowDays: 2, timeZone: "UTC" },
      { windowDays: "7", timeZone: "UTC" },
      { windowDays: 24, timeZone: "UTC" },
      { windowDays: 1, timeZone: "Not/AZone" },
      { windowDays: 1, timeZone: "" },
      { windowDays: 1, timeZone: "UTC", origins: ["demo"] },
      { windowDays: 1, timeZone: "UTC", origins: ["Claude"] },
      { windowDays: 1, timeZone: "UTC", awaitRefresh: "yes" },
      { windowDays: 1, timeZone: "UTC", path: "/Users/a/.claude/projects/x.jsonl" },
      { windowDays: 1, timeZone: "UTC", sessionId: "sess_1" },
    ];
    for (const params of bad) expect(UsageHistoryParams.safeParse(params).success).toBe(false);
  });

  it("round-trips a version 1 result", () => {
    const parsed = UsageHistoryResult.parse(result);
    expect(parsed).toEqual(result);
    expect(UsageHistoryResult.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(RpcMethods["usage.history"].result.parse(result)).toEqual(parsed);
    expect(
      UsageHistoryResult.parse({ ...result, pricing: { status: "unavailable" } }).pricing,
    ).toEqual({ status: "unavailable" });
    expect(
      UsageHistoryResult.parse({
        ...result,
        pricing: { status: "ok", asOf: result.generatedAt },
      }).pricing.status,
    ).toBe("ok");
    for (const status of ["ok", "partial", "missing", "disabled", "failed"] as const) {
      expect(
        UsageHistoryResult.safeParse({
          ...result,
          sources: [{ origin: "codex", status, files: 0, distinctSessions: 0, refreshing: false }],
        }).success,
      ).toBe(true);
    }
  });

  it("rejects paths, session ids, raw records and broken buckets", () => {
    const bad = [
      { ...result, version: 2 },
      { ...result, path: "/Users/a/.claude/projects/x.jsonl" },
      { ...result, sessionId: "sess_1" },
      { ...result, sessionKey: "opaque" },
      { ...result, records: [bucket] },
      { ...result, generatedAt: undefined },
      {
        ...result,
        buckets: [{ ...bucket, path: "/tmp/session.jsonl" }],
      },
      { ...result, buckets: [{ ...bucket, sessionId: "sess_1" }] },
      { ...result, buckets: [{ ...bucket, sessionKey: "opaque" }] },
      { ...result, buckets: [{ ...bucket, sourcePath: "/tmp/a" }] },
      { ...result, buckets: [{ ...bucket, dedupeKey: "k" }] },
      { ...result, buckets: [{ ...bucket, day: "2026-02-31" }] },
      { ...result, buckets: [{ ...bucket, day: "2026-11-18T06" }] },
      { ...result, buckets: [{ ...bucket, hour: 24 }] },
      { ...result, buckets: [{ ...bucket, hour: -1 }] },
      { ...result, buckets: [{ ...bucket, origin: "demo" }] },
      { ...result, buckets: [{ ...bucket, inputTokens: -1 }] },
      { ...result, buckets: [{ ...bucket, inputTokens: 1.5 }] },
      { ...result, buckets: [{ ...bucket, model: "" }] },
      { ...result, buckets: [{ ...bucket, records: [{ text: "hello" }] }] },
      {
        ...result,
        sources: [{ ...result.sources[0], path: "/Users/a/.codex/sessions/a.jsonl" }],
      },
      {
        ...result,
        sources: [{ ...result.sources[0], sessionId: "sess_1" }],
      },
      { ...result, pricing: { status: "fresh" } },
      { ...result, pricing: { status: "ok", path: "/tmp/rates.json" } },
    ];
    for (const payload of bad) expect(UsageHistoryResult.safeParse(payload).success).toBe(false);
  });

  it("defaults importLocalHistory on and keeps an explicit false", () => {
    expect(DeviceSettings.parse({}).importLocalHistory).toBe(true);
    expect(DeviceSettings.parse({ chatWidth: "full" }).importLocalHistory).toBe(true);
    expect(DeviceSettings.parse({ importLocalHistory: false }).importLocalHistory).toBe(false);
    expect(DeviceSettings.safeParse({ importLocalHistory: "yes" }).success).toBe(false);
  });
});

describe("HistoryReader seam", () => {
  it("keeps the shared scan limits", () => {
    expect(ImportTuning.maxLineBytes).toBe(8 * 1024 * 1024);
    expect(ImportTuning.filesPerScan).toBe(4_000);
    expect(ImportTuning.mtimeSlackMs).toBe(36 * 60 * 60 * 1000);
  });

  it("accepts a reader that reports a missing directory and carries no message text", async () => {
    const stat: HistoryStat = {
      size: 0,
      mtimeMs: 0,
      isFile: () => false,
      isDirectory: () => false,
    };
    const fs: HistoryFs = {
      readFile: () => Promise.resolve(new Uint8Array()),
      stat: () => Promise.resolve(stat),
      readdir: () => Promise.resolve([]),
    };
    const ctx: HistoryReaderContext = {
      homeDir: "/tmp/wooky-history-home",
      env: {},
      sinceMs: 0,
      untilMs: 1,
      signal: new AbortController().signal,
      fs,
    };
    const row: HistoryRecord = {
      origin: "cursor",
      model: "composer-2.5",
      sessionKey: "opaque-session",
      at: 0,
      inputTokens: 3,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      outputTokens: 4,
      reasoningTokens: 2,
      reportedCostUsd: 0.01,
      dedupeKey: "cursor:1",
    };
    const reader: HistoryReader = {
      origin: "cursor",
      read(context) {
        expect(context.homeDir).toBe("/tmp/wooky-history-home");
        const report: HistorySourceReport = { origin: "cursor", status: "missing", files: 0 };
        return Promise.resolve({ records: [row], report });
      },
    };

    const read = await reader.read(ctx);
    expect(read.report).toEqual({ origin: "cursor", status: "missing", files: 0 });
    expect(read.records).toEqual([row]);
    expect(Object.keys(row)).not.toContain("text");
    expect(Object.keys(read.report)).not.toContain("path");
  });
});
