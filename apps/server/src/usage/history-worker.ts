import { readdir, readFile, stat } from "node:fs/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Origin, UsageHistoryBucket, UsageWindowDays } from "@wooky/contracts";
import { aggregate, dedupeRecords } from "./aggregate.ts";
import {
  type CacheData,
  createRecordingFs,
  type FileEntry,
  fingerprintMatches,
  isReusable,
  loadCache,
  pruneEntry,
  RETENTION_MS,
  saveCache,
} from "./history-cache.ts";
import type {
  HistoryFileCache,
  HistoryFs,
  HistoryReader,
  HistoryRecord,
  HistorySourceReport,
} from "./history-reader.ts";
import { sanitizeNote } from "./safe-input.ts";
import { createPricer, type RateTable } from "./pricing.ts";
import { HISTORY_READERS } from "./readers/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

/** `node:fs/promises` behind the seam readers are tested against. */
export const nodeHistoryFs: HistoryFs = {
  readFile: (path) => readFile(path),
  stat: async (path) => {
    const info = await stat(path);
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      isFile: () => info.isFile(),
      isDirectory: () => info.isDirectory(),
    };
  },
  readdir: (path) => readdir(path),
};

export type WorkerRequest =
  | { kind: "scan"; nowMs: number }
  | {
      kind: "aggregate";
      nowMs: number;
      windowDays: UsageWindowDays;
      timeZone: string;
      origins: Origin[];
      rates: RateTable;
    }
  | { kind: "shutdown" };

export interface SourceSummary {
  status: HistorySourceReport["status"];
  files: number;
  note?: string;
}

export interface AggregateResponse {
  buckets: UsageHistoryBucket[];
  distinctSessions: Partial<Record<Origin, number>>;
  sources: Partial<Record<Origin, SourceSummary>>;
}

export interface WorkerInit {
  ageUsageHistory: true;
  homeDir: string;
  cachePath: string;
  /** File URL of a module exporting `HISTORY_READERS`. Tests only. Default: the registry. */
  readersModule: string | null;
}

export interface ScanTimer {
  after(ms: number): { promise: Promise<void>; cancel(): void };
}

const defaultScanTimer: ScanTimer = {
  after(ms) {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(handle) };
  },
};

export interface HistoryCoreDeps {
  readers: readonly HistoryReader[];
  fs: HistoryFs;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  cachePath: string;
  log?: (message: string) => void;
  /** Wall-clock bound on one full scan. Default 10 minutes. */
  scanTimeoutMs?: number;
  timer?: ScanTimer;
}

type OriginState = { report: HistorySourceReport; records: HistoryRecord[] };
const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

function failureNote(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,30}$/.test(code)
    ? `Could not read this history (${code}).`
    : "Could not read this history.";
}

/**
 * Scans, caches and aggregates. Holds each origin's deduped records in memory, so a request
 * for another window or zone does not touch the disk. Runs in the worker thread.
 */
export function createHistoryCore(deps: HistoryCoreDeps) {
  const log = deps.log ?? ((message: string) => console.error(`usage history: ${message}`));
  const shutdown = new AbortController();
  const scanTimeoutMs = deps.scanTimeoutMs ?? SCAN_TIMEOUT_MS;
  const timer = deps.timer ?? defaultScanTimer;
  let loading: Promise<CacheData> | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  // Every origin's deduped rows stay resident, so a window or zone change never touches the
  // disk. Roughly 10^5 to 10^6 rows (tens to a few hundred MB) for a heavy 92-day history.
  const state = new Map<Origin, OriginState>();

  function ensureLoaded(): Promise<CacheData> {
    loading ??= loadCache(deps.cachePath).then((loaded) => {
      for (const [origin, entry] of Object.entries(loaded.origins) as Array<
        [Origin, NonNullable<CacheData["origins"][Origin]>]
      >) {
        state.set(origin, { report: entry.report, records: entry.records });
      }
      return loaded;
    });
    return loading;
  }

  async function scanOne(
    reader: HistoryReader,
    nowMs: number,
    data: CacheData,
    signal: AbortSignal,
    staged: Map<Origin, OriginState>,
  ): Promise<boolean> {
    const { origin } = reader;
    const sinceMs = startOfUtcDay(nowMs - RETENTION_MS);
    const covers = startOfUtcDay(nowMs - RETENTION_MS + DAY_MS);
    const entry = data.origins[origin];
    if (
      entry !== undefined &&
      entry.fingerprint.sinceMs <= covers &&
      isReusable(entry) &&
      (await fingerprintMatches(deps.fs, entry.fingerprint, signal))
    ) {
      if (!signal.aborted) staged.set(origin, { report: entry.report, records: entry.records });
      return false;
    }
    const recording = createRecordingFs(deps.fs);
    const previousFiles = entry?.files ?? new Map<string, FileEntry>();
    const touched = new Map<string, FileEntry>();
    const fileCache: HistoryFileCache = {
      get(path, seen) {
        const hit = previousFiles.get(path);
        if (hit === undefined || hit.size !== seen.size || hit.mtimeMs !== seen.mtimeMs) return;
        touched.set(path, hit);
        return hit.records;
      },
      set(path, seen, records) {
        touched.set(path, { size: seen.size, mtimeMs: seen.mtimeMs, records });
      },
    };
    try {
      const out = await reader.read({
        homeDir: deps.homeDir,
        env: deps.env,
        sinceMs,
        untilMs: nowMs + DAY_MS,
        signal,
        fs: recording.fs,
        fileCache,
      });
      if (signal.aborted) return false;
      const report: HistorySourceReport = {
        origin,
        status: out.report.status,
        files: out.report.files,
      };
      const note = sanitizeNote(out.report.note);
      if (note !== undefined) report.note = note;
      const next = pruneEntry(
        {
          fingerprint: recording.fingerprint(sinceMs),
          report,
          records: dedupeRecords(out.records),
          // A capped scan did not visit every file, so keep the ones it did not reach.
          files:
            out.report.status === "partial" ? new Map([...previousFiles, ...touched]) : touched,
        },
        nowMs - RETENTION_MS,
      );
      data.origins[origin] = next;
      staged.set(origin, { report: next.report, records: next.records });
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      log(`${origin} reader failed`);
      const previous = state.get(origin);
      staged.set(origin, {
        report: { origin, status: "failed", files: 0, note: failureNote(error) },
        records: previous?.records ?? [],
      });
      return false;
    }
  }

  async function scan(nowMs: number): Promise<void> {
    const data = await ensureLoaded();
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown.signal, controller.signal]);
    const finished = new Set<Origin>();
    const staged = new Map<Origin, OriginState>();
    let changed = false;
    const runs = deps.readers.map(async (reader) => {
      if (await scanOne(reader, nowMs, data, signal, staged)) changed = true;
      finished.add(reader.origin);
    });
    const limit = timer.after(scanTimeoutMs);
    try {
      const outcome = await Promise.race([
        Promise.all(runs).then(() => "done" as const),
        limit.promise.then(() => "timeout" as const),
      ]);
      if (outcome === "timeout") {
        controller.abort();
        for (const { origin } of deps.readers) {
          if (finished.has(origin)) continue;
          staged.set(origin, {
            report: { origin, status: "failed", files: 0, note: "Scan timed out." },
            records: state.get(origin)?.records ?? [],
          });
        }
      }
    } finally {
      limit.cancel();
    }
    // Published in one synchronous step, so an aggregate never sees a half-updated scan.
    for (const [origin, next] of staged) state.set(origin, next);
    if (!changed) return;
    try {
      await saveCache(deps.cachePath, data);
    } catch {
      log("could not save the history cache");
    }
  }

  async function aggregateRequest(
    request: Extract<WorkerRequest, { kind: "aggregate" }>,
  ): Promise<AggregateResponse> {
    await ensureLoaded();
    const records: HistoryRecord[] = [];
    const sources: AggregateResponse["sources"] = {};
    for (const origin of request.origins) {
      const known = state.get(origin);
      if (known === undefined) continue;
      for (const record of known.records) records.push(record);
      sources[origin] = {
        status: known.report.status,
        files: known.report.files,
        ...(known.report.note === undefined ? {} : { note: known.report.note }),
      };
    }
    const { buckets, distinctSessions } = aggregate(records, {
      windowDays: request.windowDays,
      timeZone: request.timeZone,
      nowMs: request.nowMs,
      price: createPricer(request.rates),
    });
    return { buckets, distinctSessions, sources };
  }

  /** Scans run one at a time. Aggregates read `state`, which a scan swaps in whole at its end. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  }

  return {
    handle(request: WorkerRequest): Promise<AggregateResponse | null> {
      switch (request.kind) {
        case "scan":
          return enqueue(async () => {
            if (!shutdown.signal.aborted) await scan(request.nowMs);
            return null;
          });
        case "aggregate":
          return aggregateRequest(request);
        case "shutdown":
          shutdown.abort();
          return Promise.resolve(null);
      }
    },
    abort: () => shutdown.abort(),
  };
}

export type HistoryCore = ReturnType<typeof createHistoryCore>;

export interface WorkerEnvelope {
  id: number;
  request: WorkerRequest;
}

export type WorkerReply =
  { id: number; ok: true; result: AggregateResponse | null } | { id: number; ok: false };

async function startWorker(init: WorkerInit) {
  const port = parentPort;
  if (port === null) return;
  const custom =
    init.readersModule === null
      ? null
      : ((await import(init.readersModule)) as { HISTORY_READERS: readonly HistoryReader[] });
  const core = createHistoryCore({
    readers: custom?.HISTORY_READERS ?? HISTORY_READERS,
    fs: nodeHistoryFs,
    homeDir: init.homeDir,
    env: process.env,
    cachePath: init.cachePath,
  });
  port.on("close", () => core.abort());
  port.on("message", (envelope: WorkerEnvelope) => {
    void core.handle(envelope.request).then(
      (result) => {
        port.postMessage({ id: envelope.id, ok: true, result } satisfies WorkerReply);
        if (envelope.request.kind === "shutdown") port.close();
      },
      () => port.postMessage({ id: envelope.id, ok: false } satisfies WorkerReply),
    );
  });
}

const init = workerData as Partial<WorkerInit> | null;
if (!isMainThread && init?.ageUsageHistory === true) await startWorker(init as WorkerInit);
