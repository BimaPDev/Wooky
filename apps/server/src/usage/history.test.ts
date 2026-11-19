import { EventEmitter } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Origin, UsageHistoryResult } from "@age/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_FILE_NAME } from "./history-cache.ts";
import type { HistoryFs, HistoryReader, HistoryRecord } from "./history-reader.ts";
import {
  createHistoryCore,
  type ScanTimer,
  type HistoryCore,
  type AggregateResponse,
  nodeHistoryFs,
} from "./history-worker.ts";
import {
  FIXTURE_READERS_URL,
  HISTORY_READERS,
  fakeReader,
  fakeReaderRuns,
} from "./history-worker.fixture.ts";
import {
  createHistoryService,
  createWorkerHost,
  type HistoryServiceOptions,
  type HistoryTimer,
  type WorkerHost,
} from "./history.ts";
import type { WorkerEnvelope } from "./history-worker.ts";
import type { PricingService, PricingSnapshot } from "./pricing.ts";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RATES = { "test-model": { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 } };

interface Row {
  at: number;
  session?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  model?: string;
  reported?: number;
  key?: string;
}

const line = (row: Row) =>
  JSON.stringify({
    model: "test-model",
    session: "s1",
    input: 1_000_000,
    output: 500_000,
    ...row,
  });

let userHome: string;
let ageHome: string;
let clock: number;

beforeEach(async () => {
  userHome = await mkdtemp(join(tmpdir(), "age-history-user-"));
  ageHome = await mkdtemp(join(tmpdir(), "age-history-home-"));
  clock = NOW;
  fakeReaderRuns.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(userHome, { recursive: true, force: true });
  await rm(ageHome, { recursive: true, force: true });
});

async function writeFake(origin: Origin, name: string, rows: Row[]) {
  const dir = join(userHome, `fake-${origin}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), rows.map(line).join("\n") + "\n");
}

const cachePath = () => join(ageHome, CACHE_FILE_NAME);

function newCore(
  readers: readonly HistoryReader[],
  extra: Partial<Parameters<typeof createHistoryCore>[0]> = {},
): HistoryCore {
  return createHistoryCore({
    readers,
    fs: nodeHistoryFs,
    homeDir: userHome,
    env: {},
    cachePath: cachePath(),
    log: () => undefined,
    ...extra,
  });
}

const aggregateRequest = (overrides: Partial<{ windowDays: 1 | 7 | 30 | 90 }> = {}) =>
  ({
    kind: "aggregate" as const,
    nowMs: NOW,
    windowDays: overrides.windowDays ?? 7,
    timeZone: "UTC",
    origins: ["claude", "cursor", "codex", "opencode"] as Origin[],
    rates: RATES,
  }) satisfies Parameters<HistoryCore["handle"]>[0];

async function aggregateOf(core: HistoryCore): Promise<AggregateResponse> {
  const response = await core.handle(aggregateRequest());
  if (response === null) throw new Error("no aggregate");
  return response;
}

/** Reads `<home>/fake-<origin>/*.jsonl` one file at a time through `ctx.fileCache`. */
function cachingReader(origin: Origin): HistoryReader {
  return {
    origin,
    async read(ctx) {
      const dir = join(userHome, `fake-${origin}`);
      const names = await ctx.fs.readdir(dir).catch(() => [] as readonly string[]);
      const records: HistoryRecord[] = [];
      for (const name of names) {
        const path = join(dir, name);
        const stat = await ctx.fs.stat(path);
        const key = { size: stat.size, mtimeMs: stat.mtimeMs };
        const cached = ctx.fileCache?.get(path, key);
        if (cached !== undefined) {
          records.push(...cached);
          continue;
        }
        const text = new TextDecoder().decode(await ctx.fs.readFile(path));
        const parsed: HistoryRecord[] = [];
        for (const row of text.split("\n").filter((l) => l.trim() !== "")) {
          const r = JSON.parse(row) as Row & { model: string; session: string };
          parsed.push({
            origin,
            model: r.model,
            sessionKey: r.session,
            at: r.at,
            inputTokens: r.input ?? 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: r.output ?? 0,
          });
        }
        ctx.fileCache?.set(path, key, parsed);
        records.push(...parsed);
      }
      return { records, report: { origin, status: "ok", files: names.length } };
    },
  };
}

function countingFs() {
  const reads: string[] = [];
  const fs: HistoryFs = {
    ...nodeHistoryFs,
    readFile: (path) => {
      reads.push(path);
      return nodeHistoryFs.readFile(path);
    },
  };
  return { fs, reads };
}

describe("file-level cache", () => {
  const fileOf = (name: string) => join(userHome, "fake-claude", name);
  const stamp = (name: string, at: number) => utimes(fileOf(name), at / 1000, at / 1000);

  async function seed() {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    await writeFake("claude", "b.jsonl", [{ at: NOW - HOUR }]);
    await stamp("a.jsonl", NOW - HOUR);
    await stamp("b.jsonl", NOW - HOUR);
  }

  it("does not re-read an unchanged file when another file in the origin changed", async () => {
    await seed();
    const counted = countingFs();
    const core = newCore([cachingReader("claude")], { fs: counted.fs });
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(counted.reads).toHaveLength(2);

    counted.reads.length = 0;
    await appendFile(fileOf("b.jsonl"), line({ at: NOW - HOUR }) + "\n");
    await stamp("b.jsonl", NOW - 30 * 60_000);
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(counted.reads).toEqual([fileOf("b.jsonl")]);
    expect((await aggregateOf(core)).buckets[0]?.records).toBe(3);
  });

  it("serves unchanged files from the persisted cache after a restart", async () => {
    await seed();
    const first = newCore([cachingReader("claude")]);
    await first.handle({ kind: "scan", nowMs: NOW });

    await appendFile(fileOf("a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    await stamp("a.jsonl", NOW - 30 * 60_000);
    const counted = countingFs();
    const restarted = newCore([cachingReader("claude")], { fs: counted.fs });
    await restarted.handle({ kind: "scan", nowMs: NOW });
    expect(counted.reads).toEqual([fileOf("a.jsonl")]);
    expect((await aggregateOf(restarted)).buckets[0]?.records).toBe(3);
  });

  it("prunes entries for files that are gone and for files older than 92 days", async () => {
    await seed();
    await writeFake("claude", "old.jsonl", [{ at: NOW - HOUR }]);
    await stamp("old.jsonl", NOW - 100 * DAY);
    const core = newCore([cachingReader("claude")]);
    await core.handle({ kind: "scan", nowMs: NOW });
    const stored = async () =>
      (JSON.parse(await readFile(cachePath(), "utf8")).origins.claude.files as unknown[][])
        .map((file) => String(file[0]).split("/").at(-1))
        .sort();
    expect(await stored()).toEqual(["a.jsonl", "b.jsonl"]);

    await rm(fileOf("a.jsonl"));
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(await stored()).toEqual(["b.jsonl"]);
  });

  it("leaves a reader that ignores the file cache working as before", async () => {
    await seed();
    const counted = countingFs();
    const core = newCore([fakeReader("claude")], { fs: counted.fs });
    await core.handle({ kind: "scan", nowMs: NOW });
    await appendFile(fileOf("a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(counted.reads).toHaveLength(4);
    expect((await aggregateOf(core)).buckets[0]?.records).toBe(3);
    const stored = JSON.parse(await readFile(cachePath(), "utf8"));
    expect(stored.origins.claude.files).toEqual([]);
  });

  it("keeps cached files when a later run of the reader fails", async () => {
    await seed();
    let fail = false;
    const real = cachingReader("claude");
    const flaky: HistoryReader = {
      origin: "claude",
      read: (ctx) => (fail ? Promise.reject(new Error("boom")) : real.read(ctx)),
    };
    const core = newCore([flaky]);
    await core.handle({ kind: "scan", nowMs: NOW });
    fail = true;
    await appendFile(fileOf("b.jsonl"), line({ at: NOW - HOUR }) + "\n");
    await core.handle({ kind: "scan", nowMs: NOW });
    fail = false;
    const counted = countingFs();
    const again = newCore([real], { fs: counted.fs });
    await again.handle({ kind: "scan", nowMs: NOW });
    expect(counted.reads).toEqual([fileOf("b.jsonl")]);
  });
});

interface Gate {
  promise: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function gated(origin: Origin, holder: { current: Gate | null }): HistoryReader {
  const real = fakeReader(origin);
  return {
    origin,
    async read(ctx) {
      await holder.current?.promise;
      return real.read(ctx);
    },
  };
}

describe("scan core", () => {
  it("scans, dedupes across files, prices and aggregates", async () => {
    await writeFake("claude", "a.jsonl", [
      { at: NOW - HOUR, key: "m1", output: 100_000 },
      { at: NOW - HOUR, key: "m2", session: "s2" },
    ]);
    await writeFake("claude", "b.jsonl", [{ at: NOW - HOUR, key: "m1", output: 500_000 }]);
    const core = newCore([fakeReader("claude")]);
    await core.handle({ kind: "scan", nowMs: NOW });
    const out = await aggregateOf(core);
    expect(out.buckets).toHaveLength(1);
    expect(out.buckets[0]).toMatchObject({
      day: "2026-11-18",
      origin: "claude",
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      records: 2,
    });
    expect(out.buckets[0]?.costUsd).toBeCloseTo(4, 9);
    expect(out.distinctSessions).toEqual({ claude: 2 });
    expect(out.sources.claude).toEqual({ status: "ok", files: 2 });
  });

  it("serves an unchanged scan from the cache, including after a restart", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const first = newCore([fakeReader("claude"), fakeReader("codex")]);
    await first.handle({ kind: "scan", nowMs: NOW });
    await first.handle({ kind: "scan", nowMs: NOW + 1000 });
    expect(fakeReaderRuns.get("claude")).toBe(1);
    expect(fakeReaderRuns.get("codex")).toBe(1);

    const restarted = newCore([fakeReader("claude"), fakeReader("codex")]);
    await restarted.handle({ kind: "scan", nowMs: NOW + 2000 });
    expect(fakeReaderRuns.get("claude")).toBe(1);
    expect((await aggregateOf(restarted)).buckets).toHaveLength(1);
  });

  it("rescans when a file changes, a file appears or a missing directory is created", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const core = newCore([fakeReader("claude"), fakeReader("codex")]);
    await core.handle({ kind: "scan", nowMs: NOW });

    await appendFile(join(userHome, "fake-claude", "a.jsonl"), line({ at: NOW - 2 * HOUR }) + "\n");
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(fakeReaderRuns.get("claude")).toBe(2);
    expect(fakeReaderRuns.get("codex")).toBe(1);
    expect((await aggregateOf(core)).buckets[0]?.records).toBe(2);

    await writeFake("claude", "b.jsonl", [{ at: NOW - HOUR }]);
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(fakeReaderRuns.get("claude")).toBe(3);

    await writeFake("codex", "x.jsonl", [{ at: NOW - HOUR }]);
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(fakeReaderRuns.get("codex")).toBe(2);
    expect((await aggregateOf(core)).sources.codex?.status).toBe("ok");
  });

  it("discards a corrupt cache silently and rebuilds it", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    await writeFile(cachePath(), "{{ not json");
    const core = newCore([fakeReader("claude")]);
    await core.handle({ kind: "scan", nowMs: NOW });
    expect((await aggregateOf(core)).buckets).toHaveLength(1);
    expect(JSON.parse(await readFile(cachePath(), "utf8")).version).toBe(1);

    await writeFile(
      cachePath(),
      JSON.stringify({ version: 1, origins: { claude: { records: [[1]] } } }),
    );
    const again = newCore([fakeReader("claude")]);
    await again.handle({ kind: "scan", nowMs: NOW });
    expect(fakeReaderRuns.get("claude")).toBe(2);
    expect((await aggregateOf(again)).buckets).toHaveLength(1);
  });

  it("prunes rows older than 92 days from the cache and writes atomically", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - 100 * DAY }, { at: NOW - 10 * DAY }]);
    const core = newCore([fakeReader("claude")]);
    await core.handle({ kind: "scan", nowMs: NOW });
    const stored = JSON.parse(await readFile(cachePath(), "utf8"));
    expect(stored.origins.claude.records).toHaveLength(1);
    expect(await readdir(ageHome)).toEqual([CACHE_FILE_NAME]);
  });

  it("a failing reader does not fail the others and leaks no path", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const core = newCore(HISTORY_READERS);
    await core.handle({ kind: "scan", nowMs: NOW });
    const out = await aggregateOf(core);
    expect(out.sources.claude?.status).toBe("ok");
    expect(out.sources.codex).toEqual({
      status: "failed",
      files: 0,
      note: "Could not read this history (EACCES).",
    });
    expect(out.buckets).toHaveLength(1);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(userHome);
    expect(serialized).not.toContain("secret-project");
  });

  it("keeps the last good rows when a later scan of the same reader fails", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    let fail = false;
    const real = fakeReader("claude");
    const flaky: HistoryReader = {
      origin: "claude",
      read: (ctx) => (fail ? Promise.reject(new Error("boom")) : real.read(ctx)),
    };
    const core = newCore([flaky]);
    await core.handle({ kind: "scan", nowMs: NOW });
    fail = true;
    await appendFile(join(userHome, "fake-claude", "a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    await core.handle({ kind: "scan", nowMs: NOW });
    const out = await aggregateOf(core);
    expect(out.sources.claude?.status).toBe("failed");
    expect(out.buckets[0]?.records).toBe(1);
  });

  it("strips paths from a reader's own note", async () => {
    const noisy: HistoryReader = {
      origin: "cursor",
      read: async () => ({
        records: [],
        report: {
          origin: "cursor",
          status: "partial",
          files: 3,
          note: "Skipped /Users/someone/work/project/index.db and C:\\Users\\x\\y.db",
        },
      }),
    };
    const core = newCore([noisy]);
    await core.handle({ kind: "scan", nowMs: NOW });
    const note = (await aggregateOf(core)).sources.cursor?.note ?? "";
    expect(note).not.toMatch(/Users/);
    expect(note).toContain("Skipped");
  });

  it("a reader that touches no file is never served from the cache", async () => {
    let runs = 0;
    const blind: HistoryReader = {
      origin: "opencode",
      read: async () => {
        runs += 1;
        return { records: [], report: { origin: "opencode", status: "ok", files: 0 } };
      },
    };
    const core = newCore([blind]);
    await core.handle({ kind: "scan", nowMs: NOW });
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(runs).toBe(2);
  });

  it("windows the aggregate without rescanning", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }, { at: NOW - 20 * DAY }]);
    const core = newCore([fakeReader("claude")]);
    await core.handle({ kind: "scan", nowMs: NOW });
    const week = await core.handle(aggregateRequest({ windowDays: 7 }));
    const month = await core.handle(aggregateRequest({ windowDays: 30 }));
    expect(week?.buckets).toHaveLength(1);
    expect(month?.buckets).toHaveLength(2);
    expect(fakeReaderRuns.get("claude")).toBe(1);
  });
});

describe("serialized core", () => {
  it("answers an aggregate during a scan from the last settled state, never a half-updated one", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    await writeFake("codex", "a.jsonl", [{ at: NOW - HOUR }]);
    const holder: { current: Gate | null } = { current: null };
    const slow = newCore([fakeReader("claude"), gated("codex", holder)]);
    await slow.handle({ kind: "scan", nowMs: NOW });

    await appendFile(join(userHome, "fake-claude", "a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    await appendFile(join(userHome, "fake-codex", "a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    holder.current = gate();
    const scanning = slow.handle({ kind: "scan", nowMs: NOW });
    await new Promise((resolve) => setImmediate(resolve));
    const during = await slow.handle(aggregateRequest());
    expect(during?.buckets.map((b) => [b.origin, b.records])).toEqual([
      ["claude", 1],
      ["codex", 1],
    ]);
    holder.current?.open();
    await scanning;
    const after = await slow.handle(aggregateRequest());
    expect(after?.buckets.map((b) => [b.origin, b.records])).toEqual([
      ["claude", 2],
      ["codex", 2],
    ]);
  });

  it("runs scans one at a time", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const holder = { current: gate() as Gate | null };
    let active = 0;
    let peak = 0;
    const real = fakeReader("claude");
    const watched: HistoryReader = {
      origin: "claude",
      async read(ctx) {
        active += 1;
        peak = Math.max(peak, active);
        await holder.current?.promise;
        const out = await real.read(ctx);
        active -= 1;
        return out;
      },
    };
    const core = newCore([watched]);
    const first = core.handle({ kind: "scan", nowMs: NOW });
    await appendFile(join(userHome, "fake-claude", "a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    const second = core.handle({ kind: "scan", nowMs: NOW + 1 });
    await new Promise((resolve) => setImmediate(resolve));
    holder.current?.open();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it("runs shutdown ahead of queued scans, aborting the scan in flight", async () => {
    const reading = gate();
    let seen: AbortSignal | null = null;
    const hung: HistoryReader = {
      origin: "claude",
      read: (ctx) =>
        new Promise((_, reject) => {
          seen = ctx.signal;
          reading.open();
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const core = newCore([hung]);
    const scanning = core.handle({ kind: "scan", nowMs: NOW });
    const second = core.handle({ kind: "scan", nowMs: NOW });
    await reading.promise;
    await core.handle({ kind: "shutdown" });
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    await scanning;
    await second;
  });
});

interface FakeScanTimer {
  timer: ScanTimer;
  /** Resolves with the timeout asked for, once a scan has started its timer. */
  started: Promise<number>;
  /** Fires the most recently started timer. */
  fire(): void;
  cancelled(): boolean;
}
function fakeScanTimer(): FakeScanTimer {
  const fires: Array<() => void> = [];
  let startedWith!: (ms: number) => void;
  let cancelled = false;
  const started = new Promise<number>((resolve) => {
    startedWith = resolve;
  });
  return {
    started,
    fire: () => fires.at(-1)?.(),
    cancelled: () => cancelled,
    timer: {
      after(ms) {
        startedWith(ms);
        const promise = new Promise<void>((resolve) => fires.push(resolve));
        return {
          promise,
          cancel: () => {
            cancelled = true;
          },
        };
      },
    },
  };
}

describe("scan timeout", () => {
  const hangs: HistoryReader = {
    origin: "claude",
    read: () => new Promise(() => undefined),
  };

  it("marks an unfinished origin failed, keeps finished ones and settles", async () => {
    await writeFake("codex", "a.jsonl", [{ at: NOW - HOUR }]);
    const fake = fakeScanTimer();
    let seen: AbortSignal | null = null;
    const spy: HistoryReader = {
      origin: "claude",
      read: (ctx) => {
        seen = ctx.signal;
        return hangs.read(ctx);
      },
    };
    const codexDone = gate();
    const codex = fakeReader("codex");
    const signalling: HistoryReader = {
      origin: "codex",
      read: async (ctx) => {
        const out = await codex.read(ctx);
        codexDone.open();
        return out;
      },
    };
    const core = newCore([spy, signalling], { scanTimeoutMs: 1234, timer: fake.timer });
    const scanning = core.handle({ kind: "scan", nowMs: NOW });
    expect(await fake.started).toBe(1234);
    await codexDone.promise;
    fake.fire();
    await scanning;
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    const out = await aggregateOf(core);
    expect(out.sources.claude).toEqual({ status: "failed", files: 0, note: "Scan timed out." });
    expect(out.sources.codex?.status).toBe("ok");
    expect(out.buckets).toHaveLength(1);
    expect(JSON.parse(await readFile(cachePath(), "utf8")).origins.codex).toBeDefined();
  });

  it("keeps the previous rows of a timed-out origin and recovers on the next scan", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    let hang = false;
    const real = fakeReader("claude");
    const flaky: HistoryReader = {
      origin: "claude",
      read: (ctx) => (hang ? hangs.read(ctx) : real.read(ctx)),
    };
    const first = newCore([flaky]);
    await first.handle({ kind: "scan", nowMs: NOW });

    hang = true;
    await appendFile(join(userHome, "fake-claude", "a.jsonl"), line({ at: NOW - HOUR }) + "\n");
    const fake = fakeScanTimer();
    const core = newCore([flaky], { timer: fake.timer });
    const scanning = core.handle({ kind: "scan", nowMs: NOW });
    await fake.started;
    fake.fire();
    await scanning;
    const stalled = await aggregateOf(core);
    expect(stalled.sources.claude).toMatchObject({ status: "failed", note: "Scan timed out." });
    expect(stalled.buckets[0]?.records).toBe(1);

    hang = false;
    await core.handle({ kind: "scan", nowMs: NOW });
    const recovered = await aggregateOf(core);
    expect(recovered.sources.claude?.status).toBe("ok");
    expect(recovered.buckets[0]?.records).toBe(2);
  });

  it("cancels its timer when the scan finishes in time and ignores a late reader", async () => {
    const fake = fakeScanTimer();
    const core = newCore([fakeReader("claude")], { timer: fake.timer });
    await core.handle({ kind: "scan", nowMs: NOW });
    expect(fake.cancelled()).toBe(true);

    const late = gate();
    const slow: HistoryReader = {
      origin: "cursor",
      read: async () => {
        await late.promise;
        return {
          records: [
            {
              origin: "cursor",
              model: "test-model",
              sessionKey: "s",
              at: NOW - HOUR,
              inputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 1,
            },
          ],
          report: { origin: "cursor", status: "ok", files: 1 },
        };
      },
    };
    const second = fakeScanTimer();
    const timed = newCore([slow], { timer: second.timer });
    const scanning = timed.handle({ kind: "scan", nowMs: NOW });
    await second.started;
    second.fire();
    await scanning;
    late.open();
    await new Promise((resolve) => setImmediate(resolve));
    const out = await aggregateOf(timed);
    expect(out.sources.cursor?.status).toBe("failed");
    expect(out.buckets).toEqual([]);
  });
});

const pricing = (status: PricingSnapshot["status"] = "ok", asOf?: string): PricingService => {
  const snapshot: PricingSnapshot = {
    table: RATES,
    status,
    ...(asOf === undefined ? {} : { asOf }),
  };
  return { cached: async () => snapshot, load: async () => snapshot };
};

function inProcessHost(core: HistoryCore): WorkerHost & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    request(request) {
      requests.push(request.kind);
      return core.handle(request);
    },
    close: async () => core.abort(),
  };
}

function newService(
  readers: readonly HistoryReader[],
  overrides: Partial<HistoryServiceOptions> = {},
) {
  const host = inProcessHost(newCore(readers));
  const service = createHistoryService({
    home: ageHome,
    now: () => clock,
    pricing: pricing(),
    host,
    ...overrides,
  });
  return { service, host };
}

const params = (overrides: { awaitRefresh?: boolean; origins?: Origin[] } = {}) => ({
  windowDays: 7 as const,
  timeZone: "UTC",
  ...overrides,
});

describe("usage.history service", () => {
  it("returns the cache at once with refreshing set, then fresh data once awaited", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const holder: { current: Gate | null } = { current: gate() };
    const { service } = newService([gated("claude", holder)]);

    const cold = await service.get(params());
    expect(cold.buckets).toEqual([]);
    expect(cold.sources.find((s) => s.origin === "claude")).toMatchObject({
      status: "missing",
      refreshing: true,
    });

    holder.current?.open();
    const done = await service.get(params({ awaitRefresh: true }));
    expect(done.buckets).toHaveLength(1);
    expect(done.sources.find((s) => s.origin === "claude")).toMatchObject({
      status: "ok",
      files: 1,
      distinctSessions: 1,
      refreshing: false,
    });
    expect(fakeReaderRuns.get("claude")).toBe(1);
  });

  it("serves the last aggregate immediately while a rescan is still running", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const holder: { current: Gate | null } = { current: null };
    const { service } = newService([gated("claude", holder)]);
    await service.get(params({ awaitRefresh: true }));

    await appendFile(join(userHome, "fake-claude", "a.jsonl"), line({ at: NOW - 2 * HOUR }) + "\n");
    holder.current = gate();
    clock += 31_000;
    const during = await service.get(params());
    expect(during.buckets[0]?.records).toBe(1);
    expect(during.sources.find((s) => s.origin === "claude")?.refreshing).toBe(true);

    holder.current.open();
    const after = await service.get(params({ awaitRefresh: true }));
    expect(after.buckets[0]?.records).toBe(2);
    expect(after.sources.find((s) => s.origin === "claude")?.refreshing).toBe(false);
  });

  it("joins concurrent calls to one scan", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const holder: { current: Gate | null } = { current: gate() };
    const { service } = newService([gated("claude", holder)]);
    const calls = [
      service.get(params({ awaitRefresh: true })),
      service.get(params({ awaitRefresh: true })),
      service.get(params()),
    ];
    holder.current?.open();
    const results = await Promise.all(calls);
    expect(fakeReaderRuns.get("claude")).toBe(1);
    expect(results[0]?.buckets).toHaveLength(1);
    expect(results[1]?.buckets).toHaveLength(1);
  });

  it("does not start a new scan on every call", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const { service } = newService([fakeReader("claude")]);
    await service.get(params({ awaitRefresh: true }));
    const quiet = await service.get(params());
    expect(quiet.sources.find((s) => s.origin === "claude")?.refreshing).toBe(false);
    clock += 31_000;
    await service.get(params({ awaitRefresh: true }));
    expect(fakeReaderRuns.get("claude")).toBe(1);
  });

  it("bounds awaitRefresh and keeps scanning in the background", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const holder: { current: Gate | null } = { current: gate() };
    const timeout = gate();
    const never = new Promise<void>(() => undefined);
    const after = vi
      .fn<HistoryTimer["after"]>()
      .mockReturnValueOnce({ promise: timeout.promise, cancel: () => undefined })
      .mockReturnValue({ promise: never, cancel: () => undefined });
    const { service } = newService([gated("claude", holder)], { timer: { after } });
    const pending = service.get(params({ awaitRefresh: true }));
    timeout.open();
    const result = await pending;
    expect(after).toHaveBeenCalledWith(60_000);
    expect(result.buckets).toEqual([]);
    expect(result.sources.find((s) => s.origin === "claude")?.refreshing).toBe(true);
    holder.current?.open();
    expect((await service.get(params({ awaitRefresh: true }))).buckets).toHaveLength(1);
  });

  it("reports every source disabled and scans nothing when importLocalHistory is off", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    const { service, host } = newService([fakeReader("claude")], { enabled: () => false });
    const result = await service.get(params({ awaitRefresh: true }));
    expect(result.buckets).toEqual([]);
    expect(result.sources.map((s) => [s.origin, s.status, s.refreshing])).toEqual([
      ["claude", "disabled", false],
      ["cursor", "disabled", false],
      ["codex", "disabled", false],
      ["opencode", "disabled", false],
      ["antigravity", "disabled", false],
    ]);
    expect(host.requests).toEqual([]);
    expect(fakeReaderRuns.size).toBe(0);
  });

  it("picks up the setting on the next call", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    let on = false;
    const { service } = newService([fakeReader("claude")], { enabled: () => on });
    expect((await service.get(params())).sources[0]?.status).toBe("disabled");
    on = true;
    const result = await service.get(params({ awaitRefresh: true }));
    expect(result.sources.find((s) => s.origin === "claude")?.status).toBe("ok");
  });

  it("limits sources and buckets to the requested origins", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR }]);
    await writeFake("codex", "a.jsonl", [{ at: NOW - HOUR }]);
    const { service } = newService([fakeReader("claude"), fakeReader("codex")]);
    const result = await service.get(params({ awaitRefresh: true, origins: ["codex"] }));
    expect(result.sources.map((s) => s.origin)).toEqual(["codex"]);
    expect(result.buckets.map((b) => b.origin)).toEqual(["codex"]);
  });

  it("passes the pricing status through and matches the contract with no keys or paths", async () => {
    await writeFake("claude", "a.jsonl", [{ at: NOW - HOUR, session: "very-secret-session" }]);
    const asOf = new Date(NOW - 30 * HOUR).toISOString();
    const { service } = newService([fakeReader("claude")], { pricing: pricing("stale", asOf) });
    const result = await service.get(params({ awaitRefresh: true }));
    expect(result.pricing).toEqual({ status: "stale", asOf });
    expect(UsageHistoryResult.safeParse(result).success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("very-secret-session");
    expect(serialized).not.toContain(userHome);
  });

  it("marks sources failed when the worker cannot answer", async () => {
    const broken: WorkerHost = {
      request: () => Promise.reject(new Error("worker gone")),
      close: async () => undefined,
    };
    const service = createHistoryService({
      home: ageHome,
      now: () => clock,
      pricing: pricing(),
      host: broken,
    });
    const result = await service.get(params({ awaitRefresh: true }));
    expect(result.sources.every((s) => s.status === "failed")).toBe(true);
    expect(result.buckets).toEqual([]);
  });
});

class FakeWorker extends EventEmitter {
  posted: WorkerEnvelope[] = [];
  terminated = false;
  events: string[] = [];
  unref() {}
  postMessage(message: WorkerEnvelope) {
    this.posted.push(message);
    this.events.push(`post:${message.request.kind}`);
  }
  terminate() {
    this.terminated = true;
    this.events.push("terminate");
    return Promise.resolve(0);
  }
}

describe("worker host close", () => {
  const hostWith = (worker: FakeWorker, timer?: HistoryTimer) =>
    createWorkerHost({
      home: ageHome,
      userHome,
      spawn: () => worker,
      ...(timer === undefined ? {} : { timer }),
    });

  it("posts shutdown, waits for the ack, then terminates", async () => {
    const worker = new FakeWorker();
    const host = hostWith(worker);
    void host.request({ kind: "scan", nowMs: NOW }).catch(() => undefined);
    const closing = host.close();
    await new Promise((resolve) => setImmediate(resolve));
    const shutdown = worker.posted.find((envelope) => envelope.request.kind === "shutdown");
    expect(shutdown).toBeDefined();
    expect(worker.terminated).toBe(false);
    worker.emit("message", { id: shutdown?.id, ok: true, result: null });
    await closing;
    expect(worker.events).toEqual(["post:scan", "post:shutdown", "terminate"]);
  });

  it("terminates anyway when the ack does not come within the bound", async () => {
    const worker = new FakeWorker();
    let expire!: () => void;
    let waited = 0;
    const timer: HistoryTimer = {
      after(ms) {
        waited = ms;
        return {
          promise: new Promise<void>((resolve) => (expire = resolve)),
          cancel: () => undefined,
        };
      },
    };
    const host = hostWith(worker, timer);
    void host.request({ kind: "scan", nowMs: NOW }).catch(() => undefined);
    const closing = host.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.terminated).toBe(false);
    expire();
    await closing;
    expect(waited).toBe(2000);
    expect(worker.terminated).toBe(true);
  });

  it("does nothing when no worker was ever started", async () => {
    const worker = new FakeWorker();
    await hostWith(worker).close();
    expect(worker.events).toEqual([]);
  });
});

describe("worker round trip", () => {
  it("scans in a real worker thread and returns aggregates only", async () => {
    await writeFake("claude", "a.jsonl", [
      { at: NOW - HOUR, session: "round-trip-session" },
      { at: NOW - 2 * DAY, output: 1, session: "round-trip-session" },
    ]);
    const host = createWorkerHost({
      home: ageHome,
      userHome,
      readersModule: FIXTURE_READERS_URL,
    });
    const service = createHistoryService({
      home: ageHome,
      now: () => clock,
      pricing: pricing(),
      host,
    });
    try {
      const result = await service.get(params({ awaitRefresh: true }));
      expect(result.buckets.map((b) => [b.day, b.origin, b.records])).toEqual([
        ["2026-11-16", "claude", 1],
        ["2026-11-18", "claude", 1],
      ]);
      const bySource = Object.fromEntries(result.sources.map((s) => [s.origin, s]));
      expect(bySource.claude).toMatchObject({ status: "ok", files: 1, distinctSessions: 1 });
      expect(bySource.codex).toMatchObject({ status: "failed" });
      expect(bySource.cursor).toMatchObject({ status: "missing" });
      expect(JSON.stringify(result)).not.toContain("round-trip-session");
      expect(JSON.parse(await readFile(cachePath(), "utf8")).version).toBe(1);
    } finally {
      await service.close();
    }
  });
});
