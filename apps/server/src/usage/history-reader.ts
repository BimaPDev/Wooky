import type { Origin, UsageHistorySource } from "@wooky/contracts";

/**
 * One local history row. `inputTokens` is uncached input only.
 * Message text is never carried. `sessionKey` is opaque and never goes on the wire.
 */
export interface HistoryRecord {
  origin: Origin;
  model: string;
  sessionKey: string;
  /** Epoch milliseconds. */
  at: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 1-hour cache writes included in `cacheWriteTokens`. Priced higher than 5-minute writes. */
  cacheWrite1hTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  reportedCostUsd?: number;
  dedupeKey?: string;
}

/** `fs.promises`-shaped seams so a reader test can point at a temp directory. */
export interface HistoryFs {
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<HistoryStat>;
  readdir(path: string): Promise<readonly string[]>;
}

export interface HistoryStat {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** What a file looked like when it was parsed. The service compares both fields. */
export interface HistoryFileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Optional per-file cache, owned by the service. A reader that parses one file at a time
 * SHOULD call `get` before reading a file and `set` after parsing it, passing the stat taken
 * before the read. `get` returns nothing for a file that grew or changed: the service
 * compares size and mtime and never hands back an entry for a different stat.
 * Cached records must already be safe to dedupe per file; the service still dedupes globally.
 * Records handed to `set` or returned by `get` must not be mutated afterwards.
 * The service persists entries in the existing cache file, pruning those older than 92 days
 * and those for files the reader no longer reports. A reader that ignores it works as before.
 */
export interface HistoryFileCache {
  get(path: string, stat: HistoryFileStat): HistoryRecord[] | undefined;
  set(path: string, stat: HistoryFileStat, records: HistoryRecord[]): void;
}

export interface HistoryReaderContext {
  /** User home. Tests pass a temporary directory. */
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** Window start, epoch ms, inclusive. */
  sinceMs: number;
  /** Window end, epoch ms, exclusive. */
  untilMs: number;
  signal: AbortSignal;
  fs: HistoryFs;
  /** Absent when the caller offers no file cache. */
  fileCache?: HistoryFileCache;
}

export interface HistorySourceReport {
  origin: Origin;
  /** "ok" | "partial" | "missing" | "failed". Not "disabled"; the service sets that. */
  status: Exclude<UsageHistorySource["status"], "disabled">;
  files: number;
  note?: string;
}

/**
 * Pure parser: no pricing, no dedupe across files, no bucketing, no caching.
 * A missing directory returns status "missing" and does not throw.
 */
export interface HistoryReader {
  origin: Origin;
  read(ctx: HistoryReaderContext): Promise<{
    records: HistoryRecord[];
    report: HistorySourceReport;
  }>;
}

/** Shared scan limits. Readers and the history worker both honour these. */
export const ImportTuning = {
  /** JSONL line size limit. Do not buffer a longer line whole. */
  maxLineBytes: 8 * 1024 * 1024,
  /** Safety cap for one scan, above the ~1,500-file design point. Past this, status is "partial". */
  filesPerScan: 4_000,
  /** Open a file whose mtime is this far before `sinceMs`. Record timestamps still use the window. */
  mtimeSlackMs: 36 * 60 * 60 * 1000,
} as const;
