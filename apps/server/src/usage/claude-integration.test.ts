import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_FILE_NAME } from "./history-cache.ts";
import { createHistoryService, createWorkerHost } from "./history.ts";
import type { PricingService } from "./pricing.ts";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3_600_000;

const CANARY_PROMPT = "FAKE_CANARY_PROMPT_INTEGRATION_XYZ";
const CANARY_ACCOUNT = "fake-canary-account-uuid-integration";

const MODEL = "claude-integration-test-model";
const RATES = {
  [MODEL]: { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
};

const pricing = (): PricingService => {
  const snapshot = { table: RATES, status: "ok" as const };
  return { cached: async () => snapshot, load: async () => snapshot };
};

function assistantLine(overrides: Record<string, unknown> = {}): string {
  const base = {
    type: "assistant",
    timestamp: "2026-11-18T12:00:00.000Z",
    sessionId: "sess-integration",
    requestId: "req-int",
    accountUuid: CANARY_ACCOUNT,
    message: {
      id: "msg-int",
      model: MODEL,
      content: [{ type: "text", text: CANARY_PROMPT }],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
      },
    },
  };
  return `${JSON.stringify({ ...base, ...overrides })}\n`;
}

let userHome: string;
let wookyHome: string;
let clock: number;

beforeEach(async () => {
  userHome = await mkdtemp(join(tmpdir(), "wooky-claude-int-user-"));
  wookyHome = await mkdtemp(join(tmpdir(), "wooky-claude-int-home-"));
  clock = NOW;
});

afterEach(async () => {
  await rm(userHome, { recursive: true, force: true });
  await rm(wookyHome, { recursive: true, force: true });
});

async function writeJsonl(rel: string, content: string, mtimeMs: number) {
  const file = join(userHome, ".claude", "projects", rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

const cachePath = () => join(wookyHome, CACHE_FILE_NAME);

function sumChannels(
  buckets: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  }[],
) {
  return buckets.reduce(
    (acc, bucket) => ({
      inputTokens: acc.inputTokens + bucket.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + bucket.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + bucket.cacheWriteTokens,
      outputTokens: acc.outputTokens + bucket.outputTokens,
    }),
    { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  );
}

type CachedFileMeta = { size: number; mtimeMs: number; records: number };

function claudeFileMetaFromCache(raw: string): Map<string, CachedFileMeta> {
  const parsed = JSON.parse(raw) as { origins?: { claude?: { files?: unknown } } };
  const files = parsed.origins?.claude?.files;
  const out = new Map<string, CachedFileMeta>();
  if (!Array.isArray(files)) return out;
  for (const item of files) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [path, size, mtimeMs, rows] = item as [string, number, number, unknown[]];
    out.set(path, { size, mtimeMs, records: rows.length });
  }
  return out;
}

describe("claude usage history integration", () => {
  it("scans through the real worker, dedupes, and reuses per-file cache on unchanged files", async () => {
    const freshMtime = NOW - HOUR;
    const dupA = assistantLine({
      message: {
        id: "msg-dup",
        model: MODEL,
        usage: {
          input_tokens: 50,
          output_tokens: 8,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const dupB = assistantLine({
      message: {
        id: "msg-dup",
        model: MODEL,
        usage: {
          input_tokens: 50,
          output_tokens: 30,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 0,
        },
      },
    });
    await writeJsonl("p/s.jsonl", dupA + dupB, freshMtime);
    await writeJsonl(
      "p/untouched.jsonl",
      assistantLine({
        message: {
          id: "msg-other",
          model: MODEL,
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      freshMtime,
    );

    const host = createWorkerHost({ home: wookyHome, userHome });
    const service = createHistoryService({
      home: wookyHome,
      userHome,
      now: () => clock,
      pricing: pricing(),
      host,
    });

    try {
      const first = await service.get({
        windowDays: 30,
        timeZone: "America/New_York",
        awaitRefresh: true,
      });
      const claude = first.sources.find((s) => s.origin === "claude");
      expect(claude).toMatchObject({ status: "ok", files: 2 });

      const claudeBuckets = first.buckets.filter((b) => b.origin === "claude");
      expect(claudeBuckets.length).toBeGreaterThan(0);
      const totals = sumChannels(claudeBuckets);
      expect(totals).toEqual({
        inputTokens: 60,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        outputTokens: 130,
      });
      expect(claudeBuckets.reduce((n, b) => n + b.records, 0)).toBe(2);

      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain(CANARY_PROMPT);
      expect(serialized).not.toContain(CANARY_ACCOUNT);
      expect(serialized).not.toContain(userHome);

      const cacheAfterFirst = await readFile(cachePath(), "utf8");
      const metaFirst = claudeFileMetaFromCache(cacheAfterFirst);
      expect(metaFirst.size).toBe(2);

      await appendFile(
        join(userHome, ".claude", "projects", "p", "s.jsonl"),
        assistantLine({
          message: {
            id: "msg-new",
            model: MODEL,
            usage: {
              input_tokens: 7,
              output_tokens: 11,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      );
      const changedPath = join(userHome, ".claude", "projects", "p", "s.jsonl");
      const touchedAt = freshMtime + 5 * 60_000;
      await utimes(changedPath, touchedAt / 1000, touchedAt / 1000);

      clock += 31_000;
      const second = await service.get({
        windowDays: 30,
        timeZone: "America/New_York",
        awaitRefresh: true,
      });
      const totalsAfter = sumChannels(second.buckets.filter((b) => b.origin === "claude"));
      expect(totalsAfter.outputTokens).toBe(141);
      expect(
        second.buckets.filter((b) => b.origin === "claude").reduce((n, b) => n + b.records, 0),
      ).toBe(3);

      const metaSecond = claudeFileMetaFromCache(await readFile(cachePath(), "utf8"));
      const untouchedPath = [...metaSecond.keys()].find((path) => path.endsWith("untouched.jsonl"));
      const changed = [...metaSecond.keys()].find((path) => path.endsWith("s.jsonl"));
      expect(untouchedPath).toBeDefined();
      expect(changed).toBeDefined();
      if (untouchedPath === undefined || changed === undefined) return;
      const beforeUntouched = metaFirst.get(untouchedPath);
      const afterUntouched = metaSecond.get(untouchedPath);
      expect(afterUntouched).toEqual(beforeUntouched);
      expect(metaSecond.get(changed)?.size).toBeGreaterThan(metaFirst.get(changed)?.size ?? 0);
      expect(metaSecond.get(changed)?.records).toBe(3);
    } finally {
      await service.close();
    }
  });
});
