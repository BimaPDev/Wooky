import type { Origin, UsageHistorySource } from "@age/contracts";

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
