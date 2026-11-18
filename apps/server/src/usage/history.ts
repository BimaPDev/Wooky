import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  Origin,
  UsageHistoryBucket,
  type UsageHistoryParams,
  type UsageHistoryResult,
  type UsageHistorySource,
} from "@age/contracts";
import { z } from "zod";
import { CACHE_FILE_NAME } from "./history-cache.ts";
import type {
  AggregateResponse,
  WorkerEnvelope,
  WorkerInit,
  WorkerReply,
  WorkerRequest,
} from "./history-worker.ts";
import { createPricingService, type PricingService, type PricingSnapshot } from "./pricing.ts";

const AWAIT_REFRESH_MS = 60_000;
/** A call that does not ask to wait starts a rescan only when the last one is this old. */
const RESCAN_INTERVAL_MS = 30_000;

/** The thread the scan runs on. Tests swap it for the core running in-process. */
export interface WorkerHost {
  request(request: WorkerRequest): Promise<AggregateResponse | null>;
  close(): Promise<void>;
}

export interface WorkerHostOptions {
  /** AGE_HOME. The scan cache lives there. */
  home: string;
  /** User home the readers look under. */
  userHome: string;
  env?: NodeJS.ProcessEnv;
  /** File URL of a module exporting `HISTORY_READERS`. Tests only. */
  readersModule?: string;
}

/** One long-lived `worker_threads` Worker, started on first use and restarted if it dies. */
export function createWorkerHost(options: WorkerHostOptions): WorkerHost {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: AggregateResponse | null) => void; reject: (error: Error) => void }
  >();

  function failAll(message: string) {
    for (const entry of pending.values()) entry.reject(new Error(message));
    pending.clear();
  }

  function start(): Worker {
    const init: WorkerInit = {
      ageUsageHistory: true,
      homeDir: options.userHome,
      cachePath: join(options.home, CACHE_FILE_NAME),
      readersModule: options.readersModule ?? null,
    };
    const created = new Worker(new URL("./history-worker.ts", import.meta.url), {
      workerData: init,
      env: options.env ?? process.env,
    });
    created.unref();
    created.on("message", (reply: WorkerReply) => {
      const entry = pending.get(reply.id);
      if (entry === undefined) return;
      pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.result);
      else entry.reject(new Error("history worker request failed"));
    });
    created.on("error", () => {
      console.error("usage history: the scan worker crashed");
      failAll("history worker crashed");
    });
    created.on("exit", () => {
      if (worker === created) worker = null;
      failAll("history worker exited");
    });
    return created;
  }

  return {
    request(request) {
      worker ??= start();
      const id = nextId++;
      const envelope: WorkerEnvelope = { id, request };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker?.postMessage(envelope);
      });
    },
    async close() {
      const current = worker;
      worker = null;
      if (current === null) return;
      failAll("history worker closed");
      await current.terminate();
    },
  };
}

const AggregateResponseSchema = z.object({
  buckets: z.array(UsageHistoryBucket),
  distinctSessions: z.partialRecord(Origin, z.number().int().nonnegative()),
  sources: z.partialRecord(
    Origin,
    z.object({
      status: z.enum(["ok", "partial", "missing", "failed"]),
      files: z.number().int().nonnegative(),
      note: z.string().optional(),
    }),
  ),
});

export interface HistoryTimer {
  after(ms: number): { promise: Promise<void>; cancel(): void };
}

export interface HistoryServiceOptions {
  /** AGE_HOME: where the scan cache and the rate table live. Tests pass a temp directory. */
  home: string;
  /** User home the readers look under. Default: the OS home. */
  userHome?: string;
  /** Read per call, so the setting takes effect without a restart. */
  enabled?: () => boolean;
  now?: () => number;
  fetch?: typeof fetch;
  pricing?: PricingService;
  host?: WorkerHost;
  env?: NodeJS.ProcessEnv;
  awaitRefreshMs?: number;
  rescanIntervalMs?: number;
  timer?: HistoryTimer;
}

export interface HistoryService {
  get(params: UsageHistoryParams): Promise<UsageHistoryResult>;
  close(): Promise<void>;
}

const defaultTimer: HistoryTimer = {
  after(ms) {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(handle) };
  },
};

export function createHistoryService(options: HistoryServiceOptions): HistoryService {
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? (() => true);
  const awaitRefreshMs = options.awaitRefreshMs ?? AWAIT_REFRESH_MS;
  const rescanIntervalMs = options.rescanIntervalMs ?? RESCAN_INTERVAL_MS;
  const timer = options.timer ?? defaultTimer;
  const host =
    options.host ??
    createWorkerHost({
      home: options.home,
      userHome: options.userHome ?? homedir(),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  const pricing =
    options.pricing ??
    createPricingService({
      home: options.home,
      now,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  let inflight: Promise<void> | null = null;
  let lastScanAt: number | null = null;
  let scanFailed = false;
  let latestPricing: PricingSnapshot | null = null;
  let closed = false;

  function startRefresh(): Promise<void> {
    inflight ??= (async () => {
      try {
        const [snapshot] = await Promise.all([
          pricing.load(),
          host.request({ kind: "scan", nowMs: now() }),
        ]);
        latestPricing = snapshot;
        scanFailed = false;
      } catch {
        scanFailed = true;
        console.error("usage history: the scan did not finish");
      } finally {
        lastScanAt = now();
        inflight = null;
      }
    })();
    return inflight;
  }

  async function waitBounded(scan: Promise<void>): Promise<void> {
    const limit = timer.after(awaitRefreshMs);
    try {
      await Promise.race([scan, limit.promise]);
    } finally {
      limit.cancel();
    }
  }

  const origins = (params: UsageHistoryParams): Origin[] => params.origins ?? Origin.options;

  function disabled(params: UsageHistoryParams): UsageHistoryResult {
    return {
      version: 1,
      buckets: [],
      sources: origins(params).map((origin) => ({
        origin,
        status: "disabled",
        files: 0,
        distinctSessions: 0,
        refreshing: false,
      })),
      pricing: { status: "unavailable" },
      generatedAt: new Date(now()).toISOString(),
    };
  }

  async function get(params: UsageHistoryParams): Promise<UsageHistoryResult> {
    if (!enabled() || closed) return disabled(params);
    const wanted = origins(params);

    let scan = inflight;
    const due = lastScanAt === null || now() - lastScanAt >= rescanIntervalMs;
    if (scan === null && (params.awaitRefresh === true || due)) scan = startRefresh();
    if (params.awaitRefresh === true && scan !== null) await waitBounded(scan);

    const snapshot = latestPricing ?? (await pricing.cached());
    let response: AggregateResponse | null = null;
    let aggregateFailed = false;
    try {
      const reply = await host.request({
        kind: "aggregate",
        nowMs: now(),
        windowDays: params.windowDays,
        timeZone: params.timeZone,
        origins: wanted,
        rates: snapshot.table,
      });
      response = reply === null ? null : AggregateResponseSchema.parse(reply);
    } catch {
      aggregateFailed = true;
    }

    const refreshing = inflight !== null;
    const sources: UsageHistorySource[] = wanted.map((origin) => {
      const known = response?.sources[origin];
      if (known === undefined) {
        return scanFailed || aggregateFailed
          ? {
              origin,
              status: "failed",
              files: 0,
              distinctSessions: 0,
              refreshing,
              note: "The history scan stopped unexpectedly.",
            }
          : { origin, status: "missing", files: 0, distinctSessions: 0, refreshing };
      }
      return {
        origin,
        status: known.status,
        files: known.files,
        distinctSessions: response?.distinctSessions[origin] ?? 0,
        refreshing,
        ...(known.note === undefined ? {} : { note: known.note }),
      };
    });

    return {
      version: 1,
      buckets: response?.buckets ?? [],
      sources,
      pricing: {
        status: snapshot.status,
        ...(snapshot.asOf === undefined ? {} : { asOf: snapshot.asOf }),
      },
      generatedAt: new Date(now()).toISOString(),
    };
  }

  return {
    get,
    async close() {
      closed = true;
      await host.close();
    },
  };
}
