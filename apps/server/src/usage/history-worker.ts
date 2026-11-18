import { readdir, readFile, stat } from "node:fs/promises";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Origin, UsageHistoryBucket, UsageWindowDays } from "@age/contracts";
import { aggregate, dedupeRecords } from "./aggregate.ts";
import {
  type CacheData,
  createRecordingFs,
  fingerprintMatches,
  isReusable,
  loadCache,
  pruneEntry,
  RETENTION_MS,
  saveCache,
} from "./history-cache.ts";
import type {
  HistoryFs,
  HistoryReader,
  HistoryRecord,
  HistorySourceReport,
} from "./history-reader.ts";
import { createPricer, type RateTable } from "./pricing.ts";
import { HISTORY_READERS } from "./readers/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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

export interface HistoryCoreDeps {
  readers: readonly HistoryReader[];
  fs: HistoryFs;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  cachePath: string;
  log?: (message: string) => void;
}

const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/** A reader's note must not carry a path. Anything with a separator in it is dropped. */
function safeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const scrubbed = note.replace(/(?:[A-Za-z]:|~)?[\\/]\S+/g, "…").trim();
  return scrubbed === "" ? undefined : scrubbed.slice(0, 200);
}

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
  let loading: Promise<CacheData> | null = null;
  const state = new Map<Origin, { report: HistorySourceReport; records: HistoryRecord[] }>();

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

  async function scanOne(reader: HistoryReader, nowMs: number, data: CacheData): Promise<boolean> {
    const { origin } = reader;
    const sinceMs = startOfUtcDay(nowMs - RETENTION_MS);
    const covers = startOfUtcDay(nowMs - RETENTION_MS + DAY_MS);
    const entry = data.origins[origin];
    if (
      entry !== undefined &&
      entry.fingerprint.sinceMs <= covers &&
      isReusable(entry) &&
      (await fingerprintMatches(deps.fs, entry.fingerprint, shutdown.signal))
    ) {
      return false;
    }
    const recording = createRecordingFs(deps.fs);
    try {
      const out = await reader.read({
        homeDir: deps.homeDir,
        env: deps.env,
        sinceMs,
        untilMs: nowMs + DAY_MS,
        signal: shutdown.signal,
        fs: recording.fs,
      });
      const report: HistorySourceReport = {
        origin,
        status: out.report.status,
        files: out.report.files,
      };
      const note = safeNote(out.report.note);
      if (note !== undefined) report.note = note;
      const next = pruneEntry(
        {
          fingerprint: recording.fingerprint(sinceMs),
          report,
          records: dedupeRecords(out.records),
        },
        nowMs - RETENTION_MS,
      );
      data.origins[origin] = next;
      state.set(origin, { report: next.report, records: next.records });
      return true;
    } catch (error) {
      log(`${origin} reader failed`);
      const previous = state.get(origin);
      state.set(origin, {
        report: { origin, status: "failed", files: 0, note: failureNote(error) },
        records: previous?.records ?? [],
      });
      return false;
    }
  }

  async function scan(nowMs: number): Promise<void> {
    const data = await ensureLoaded();
    const changed = await Promise.all(deps.readers.map((reader) => scanOne(reader, nowMs, data)));
    if (!changed.includes(true)) return;
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

  return {
    async handle(request: WorkerRequest): Promise<AggregateResponse | null> {
      switch (request.kind) {
        case "scan":
          await scan(request.nowMs);
          return null;
        case "aggregate":
          return aggregateRequest(request);
        case "shutdown":
          shutdown.abort();
          return null;
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
