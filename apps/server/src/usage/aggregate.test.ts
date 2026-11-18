import type { Origin } from "@age/contracts";
import { describe, expect, it } from "vitest";
import { aggregate, dedupeRecords } from "./aggregate.ts";
import type { HistoryRecord } from "./history-reader.ts";
import { createPricer, type RateTable } from "./pricing.ts";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RATES: RateTable = {
  "test-model": { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
};
const price = createPricer(RATES);

function rec(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    origin: "claude",
    model: "test-model",
    sessionKey: "s1",
    at: NOW - HOUR,
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    ...overrides,
  };
}

const run = (
  records: HistoryRecord[],
  options: {
    windowDays?: 1 | 7 | 30 | 90;
    timeZone?: string;
    nowMs?: number;
    origins?: Origin[];
  } = {},
) =>
  aggregate(records, {
    windowDays: options.windowDays ?? 7,
    timeZone: options.timeZone ?? "UTC",
    nowMs: options.nowMs ?? NOW,
    price,
    ...(options.origins === undefined ? {} : { origins: options.origins }),
  });

describe("dedupeRecords", () => {
  it("collapses a shared key to the max of each channel", () => {
    const out = dedupeRecords([
      rec({ dedupeKey: "m1", inputTokens: 5, outputTokens: 2, cacheReadTokens: 9 }),
      rec({ dedupeKey: "m1", inputTokens: 5, outputTokens: 40, cacheReadTokens: 3 }),
      rec({ dedupeKey: "m1", inputTokens: 7, outputTokens: 1, reportedCostUsd: 0.5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 40,
      cacheReadTokens: 9,
      reportedCostUsd: 0.5,
    });
  });

  it("keeps every record that has no key, and keys apart per origin", () => {
    const out = dedupeRecords([
      rec(),
      rec(),
      rec({ origin: "codex", dedupeKey: "k" }),
      rec({ origin: "claude", dedupeKey: "k" }),
    ]);
    expect(out).toHaveLength(4);
  });

  it("does not mutate its input", () => {
    const first = rec({ dedupeKey: "m", outputTokens: 1 });
    dedupeRecords([first, rec({ dedupeKey: "m", outputTokens: 9 })]);
    expect(first.outputTokens).toBe(1);
  });
});

describe("window filter", () => {
  it("keeps the last N calendar days including today and drops the rest", () => {
    const { buckets } = run([
      rec({ at: Date.UTC(2026, 10, 12, 0, 0) }),
      rec({ at: Date.UTC(2026, 10, 11, 23, 59) }),
      rec({ at: NOW + 2 * DAY }),
    ]);
    expect(buckets.map((b) => b.day)).toEqual(["2026-11-12"]);
  });

  it("the 24-hour window is hourly and ends at now", () => {
    const { buckets } = run(
      [
        rec({ at: NOW - 23 * HOUR }),
        rec({ at: NOW - 25 * HOUR }),
        rec({ at: NOW - HOUR }),
        rec({ at: NOW + HOUR }),
      ],
      { windowDays: 1 },
    );
    expect(buckets.map((b) => [b.day, b.hour])).toEqual([
      ["2026-11-17", 13],
      ["2026-11-18", 11],
    ]);
  });

  it("the day windows carry no hour", () => {
    const { buckets } = run([rec()]);
    expect(buckets[0]?.hour).toBeUndefined();
  });

  it("filters by origin", () => {
    const { buckets, distinctSessions } = run([rec(), rec({ origin: "codex", sessionKey: "c" })], {
      origins: ["codex"],
    });
    expect(buckets.map((b) => b.origin)).toEqual(["codex"]);
    expect(distinctSessions).toEqual({ codex: 1 });
  });
});

describe("time zones", () => {
  const late = rec({ at: Date.UTC(2026, 10, 18, 23, 30) });

  it("buckets by the requested zone's calendar day", () => {
    const nowMs = Date.UTC(2026, 10, 19, 12, 0);
    const utc = run([late], { nowMs });
    const tokyo = run([late], { nowMs, timeZone: "Asia/Tokyo" });
    const la = run([late], { nowMs, timeZone: "America/Los_Angeles" });
    expect(utc.buckets.map((b) => b.day)).toEqual(["2026-11-18"]);
    expect(tokyo.buckets.map((b) => b.day)).toEqual(["2026-11-19"]);
    expect(la.buckets.map((b) => b.day)).toEqual(["2026-11-18"]);
  });

  it("handles a half-hour offset", () => {
    const { buckets } = run([rec({ at: Date.UTC(2026, 10, 17, 18, 45) })], {
      timeZone: "Asia/Kolkata",
      windowDays: 1,
    });
    expect([buckets[0]?.day, buckets[0]?.hour]).toEqual(["2026-11-18", 0]);
  });

  it("folds the repeated hour when the clocks go back", () => {
    // New York leaves daylight time at 06:00Z on 2026-11-01: 01:30 happens twice.
    const nowMs = Date.UTC(2026, 10, 1, 12, 0);
    const { buckets } = run(
      [
        rec({ at: Date.UTC(2026, 10, 1, 5, 30) }),
        rec({ at: Date.UTC(2026, 10, 1, 6, 30) }),
        rec({ at: Date.UTC(2026, 10, 1, 7, 30) }),
      ],
      { windowDays: 1, timeZone: "America/New_York", nowMs },
    );
    expect(buckets.map((b) => [b.day, b.hour, b.records])).toEqual([
      ["2026-11-01", 1, 2],
      ["2026-11-01", 2, 1],
    ]);
  });

  it("skips the missing hour when the clocks go forward", () => {
    // New York enters daylight time at 07:00Z on 2026-03-08: 02:00 does not exist.
    const nowMs = Date.UTC(2026, 2, 8, 12, 0);
    const { buckets } = run(
      [rec({ at: Date.UTC(2026, 2, 8, 6, 59) }), rec({ at: Date.UTC(2026, 2, 8, 7, 0) })],
      { windowDays: 1, timeZone: "America/New_York", nowMs },
    );
    expect(buckets.map((b) => b.hour)).toEqual([1, 3]);
  });

  it("puts local midnight on either side of a DST day in the right day", () => {
    const nowMs = Date.UTC(2026, 10, 2, 12, 0);
    const { buckets } = run(
      [
        rec({ at: Date.UTC(2026, 10, 1, 4, 30) }), // 00:30 EDT, Nov 1
        rec({ at: Date.UTC(2026, 10, 2, 4, 59) }), // 23:59 EST, Nov 1
        rec({ at: Date.UTC(2026, 10, 2, 5, 0) }), // 00:00 EST, Nov 2
      ],
      { timeZone: "America/New_York", nowMs },
    );
    expect(buckets.map((b) => [b.day, b.records])).toEqual([
      ["2026-11-01", 2],
      ["2026-11-02", 1],
    ]);
  });
});

describe("buckets", () => {
  it("sums tokens, prices them and counts unpriced records", () => {
    const { buckets } = run([
      rec({ inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000 }),
      rec({ model: "mystery", inputTokens: 50 }),
      rec({ model: "mystery", inputTokens: 50, reportedCostUsd: 0.25 }),
    ]);
    const known = buckets.find((b) => b.model === "test-model");
    expect(known).toMatchObject({
      inputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      outputTokens: 500_000,
      records: 1,
      unpricedRecords: 0,
    });
    expect(known?.costByType.input).toBeCloseTo(1, 9);
    expect(known?.costByType.cacheRead).toBeCloseTo(0.2, 9);
    expect(known?.costByType.output).toBeCloseTo(1, 9);
    expect(known?.costUsd).toBeCloseTo(2.2, 9);
    expect(known?.cacheSavingsUsd).toBeCloseTo(1.8, 9);
    const unknown = buckets.find((b) => b.model === "mystery");
    expect(unknown).toMatchObject({ records: 2, unpricedRecords: 1 });
    expect(unknown?.costUsd).toBeCloseTo(0.25, 9);
    expect(unknown?.costByType.other).toBeCloseTo(0.25, 9);
  });

  it("counts distinct sessions per origin over the window and never returns keys", () => {
    const result = run([
      rec({ sessionKey: "a" }),
      rec({ sessionKey: "a", at: NOW - DAY }),
      rec({ sessionKey: "b" }),
      rec({ origin: "cursor", sessionKey: "a" }),
      rec({ sessionKey: "old", at: NOW - 30 * DAY }),
    ]);
    expect(result.distinctSessions).toEqual({ claude: 2, cursor: 1 });
    expect(JSON.stringify(result)).not.toContain('"old"');
  });

  it("orders buckets by day, hour, origin and model", () => {
    const { buckets } = run([
      rec({ at: NOW }),
      rec({ at: NOW - DAY }),
      rec({ origin: "codex", at: NOW - DAY }),
    ]);
    expect(buckets.map((b) => [b.day, b.origin])).toEqual([
      ["2026-11-17", "claude"],
      ["2026-11-17", "codex"],
      ["2026-11-18", "claude"],
    ]);
  });

  it("includes reasoning tokens only when present", () => {
    const { buckets } = run([rec({ reasoningTokens: 7 }), rec({ model: "other" })]);
    expect(buckets.find((b) => b.model === "test-model")?.reasoningTokens).toBe(7);
    expect(buckets.find((b) => b.model === "other")?.reasoningTokens).toBeUndefined();
  });
});

describe("performance", () => {
  it("aggregates 200k synthetic records well inside a second", () => {
    const models = ["test-model", "claude-sonnet-4-5", "gpt-5", "mystery"];
    const origins: Origin[] = ["claude", "cursor", "codex", "opencode"];
    const records: HistoryRecord[] = [];
    for (let i = 0; i < 200_000; i++) {
      records.push(
        rec({
          origin: origins[i % 4] as Origin,
          model: models[i % 3] as string,
          sessionKey: `s${i % 900}`,
          at: NOW - ((i * 7_919) % (88 * DAY)),
          inputTokens: 100 + (i % 50),
          cacheReadTokens: i % 5000,
          outputTokens: 10 + (i % 90),
        }),
      );
    }
    const started = performance.now();
    const { buckets } = run(dedupeRecords(records), {
      windowDays: 90,
      timeZone: "America/New_York",
    });
    const elapsed = performance.now() - started;
    expect(buckets.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(1000);
  });
});
