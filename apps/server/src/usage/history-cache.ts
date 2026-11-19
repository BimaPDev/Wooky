import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat as statFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Origin } from "@wooky/contracts";
import type {
  HistoryFs,
  HistoryRecord,
  HistorySourceReport,
  HistoryStat,
} from "./history-reader.ts";
import { parseJsonSafely, sanitizeNote } from "./safe-input.ts";

export const CACHE_FILE_NAME = "usage-history-cache-v1.json";
export const RETENTION_MS = 92 * 24 * 60 * 60 * 1000;
/** A cache file above this is treated as corrupt and rebuilt, not parsed. */
export const MAX_CACHE_BYTES = 128 * 1024 * 1024;

const ORIGINS: readonly Origin[] = ["claude", "cursor", "codex", "opencode", "antigravity"];
const STATUSES = new Set<string>(["ok", "partial", "missing", "failed"]);

/**
 * What a reader looked at, so an unchanged scan can be served from the cache.
 * Readers get no previous state, so this is recorded from outside through the `HistoryFs`
 * they are handed: every stat and directory listing, and the stat of every file read.
 */
export interface InputFingerprint {
  /** The window the cached output covers. */
  sinceMs: number;
  /** Path, size and mtime. `null` when the path did not exist or could not be read. */
  files: Array<[path: string, size: number | null, mtimeMs: number | null]>;
  /** Path and a hash of the sorted entry names. `null` when the listing failed. */
  dirs: Array<[path: string, names: string | null]>;
}

/** One file's parsed rows, valid while its size and mtime are unchanged. */
export interface FileEntry {
  size: number;
  mtimeMs: number;
  records: HistoryRecord[];
}

export interface OriginEntry {
  fingerprint: InputFingerprint;
  report: HistorySourceReport;
  /** Reader output, already deduped by `dedupeKey`. */
  records: HistoryRecord[];
  /** Per-file rows for readers that use `HistoryReaderContext.fileCache`, keyed by path. */
  files: Map<string, FileEntry>;
}

export interface CacheData {
  version: 1;
  origins: Partial<Record<Origin, OriginEntry>>;
}

export function emptyCache(): CacheData {
  return { version: 1, origins: {} };
}

const hashNames = (names: readonly string[]) =>
  createHash("sha1")
    .update([...names].sort().join("\u0000"))
    .digest("hex");

/** Wraps `real` and notes everything read through it. One per reader run. */
export function createRecordingFs(real: HistoryFs): {
  fs: HistoryFs;
  fingerprint(sinceMs: number): InputFingerprint;
} {
  const files = new Map<string, [number | null, number | null]>();
  const dirs = new Map<string, string | null>();

  const noteStat = (path: string, stat: HistoryStat | null) => {
    if (files.has(path)) return;
    files.set(path, stat === null ? [null, null] : [stat.size, stat.mtimeMs]);
  };

  const fs: HistoryFs = {
    async stat(path) {
      try {
        const stat = await real.stat(path);
        noteStat(path, stat);
        return stat;
      } catch (error) {
        noteStat(path, null);
        throw error;
      }
    },
    async readdir(path) {
      try {
        const names = await real.readdir(path);
        if (!dirs.has(path)) dirs.set(path, hashNames(names));
        return names;
      } catch (error) {
        if (!dirs.has(path)) dirs.set(path, null);
        throw error;
      }
    },
    async readFile(path) {
      if (!files.has(path)) {
        // Stat before reading, so a write that lands mid-read shows up as a change next time.
        noteStat(path, await real.stat(path).catch(() => null));
      }
      return real.readFile(path);
    },
  };

  return {
    fs,
    fingerprint: (sinceMs) => ({
      sinceMs,
      files: [...files].map(([path, [size, mtime]]) => [path, size, mtime]),
      dirs: [...dirs],
    }),
  };
}

/** Whether re-running the reader would see exactly what it saw before. */
export async function fingerprintMatches(
  real: HistoryFs,
  fingerprint: InputFingerprint,
  signal: AbortSignal,
): Promise<boolean> {
  const checks: Array<() => Promise<boolean>> = [
    ...fingerprint.files.map(([path, size, mtimeMs]) => async () => {
      try {
        const stat = await real.stat(path);
        return stat.size === size && stat.mtimeMs === mtimeMs;
      } catch {
        return size === null;
      }
    }),
    ...fingerprint.dirs.map(([path, names]) => async () => {
      try {
        return hashNames(await real.readdir(path)) === names;
      } catch {
        return names === null;
      }
    }),
  ];
  const batch = 64;
  for (let index = 0; index < checks.length; index += batch) {
    if (signal.aborted) return false;
    const results = await Promise.all(checks.slice(index, index + batch).map((check) => check()));
    if (results.includes(false)) return false;
  }
  return true;
}

/** True when the entry can stand in for a re-run. A reader that touched no file never can. */
export function isReusable(entry: OriginEntry): boolean {
  const { fingerprint, report } = entry;
  return (
    (report.status === "ok" || report.status === "missing") &&
    fingerprint.files.length + fingerprint.dirs.length > 0
  );
}

type Tuple = [
  at: number,
  model: string,
  sessionKey: string,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reasoning: number | null,
  reportedCostUsd: number | null,
  dedupeKey: string | null,
  cacheWrite1h: number | null,
];

const encodeRecord = (r: HistoryRecord): Tuple => [
  r.at,
  r.model,
  r.sessionKey,
  r.inputTokens,
  r.cacheReadTokens,
  r.cacheWriteTokens,
  r.outputTokens,
  r.reasoningTokens ?? null,
  r.reportedCostUsd ?? null,
  r.dedupeKey ?? null,
  r.cacheWrite1hTokens ?? null,
];

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNullableNumber = (value: unknown) => value === null || isNumber(value);
const isNullableString = (value: unknown) => value === null || typeof value === "string";

/** Hand-checked rather than zod: a cache holds hundreds of thousands of rows. */
function decodeRecord(origin: Origin, value: unknown): HistoryRecord | null {
  if (!Array.isArray(value) || (value.length !== 10 && value.length !== 11)) return null;
  const [
    at,
    model,
    sessionKey,
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    reported,
    key,
    cacheWrite1h,
  ] = value as unknown[];
  if (
    !isNumber(at) ||
    typeof model !== "string" ||
    typeof sessionKey !== "string" ||
    !isNumber(input) ||
    !isNumber(cacheRead) ||
    !isNumber(cacheWrite) ||
    !isNumber(output) ||
    !isNullableNumber(reasoning) ||
    !isNullableNumber(reported) ||
    !isNullableString(key) ||
    (value.length === 11 && !isNullableNumber(cacheWrite1h))
  )
    return null;
  const record: HistoryRecord = {
    origin,
    model,
    sessionKey,
    at,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
  };
  if (typeof reasoning === "number") record.reasoningTokens = reasoning;
  if (typeof reported === "number") record.reportedCostUsd = reported;
  if (typeof key === "string") record.dedupeKey = key;
  if (typeof cacheWrite1h === "number") record.cacheWrite1hTokens = cacheWrite1h;
  return record;
}

function decodeReport(origin: Origin, value: unknown): HistorySourceReport | null {
  if (typeof value !== "object" || value === null) return null;
  const { status, files, note } = value as Record<string, unknown>;
  if (typeof status !== "string" || !STATUSES.has(status) || !isNumber(files)) return null;
  if (note !== undefined && typeof note !== "string") return null;
  const report: HistorySourceReport = {
    origin,
    status: status as HistorySourceReport["status"],
    files,
  };
  const safe = sanitizeNote(note);
  if (safe !== undefined) report.note = safe;
  return report;
}

function decodeFingerprint(value: unknown): InputFingerprint | null {
  if (typeof value !== "object" || value === null) return null;
  const { sinceMs, files, dirs } = value as Record<string, unknown>;
  if (!isNumber(sinceMs) || !Array.isArray(files) || !Array.isArray(dirs)) return null;
  const fileOk = (f: unknown) =>
    Array.isArray(f) &&
    f.length === 3 &&
    typeof f[0] === "string" &&
    isNullableNumber(f[1]) &&
    isNullableNumber(f[2]);
  const dirOk = (d: unknown) =>
    Array.isArray(d) && d.length === 2 && typeof d[0] === "string" && isNullableString(d[1]);
  if (!files.every(fileOk) || !dirs.every(dirOk)) return null;
  return { sinceMs, files, dirs } as InputFingerprint;
}

function decodeEntry(origin: Origin, value: unknown): OriginEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const { fingerprint, report, records, files } = value as Record<string, unknown>;
  const decodedFingerprint = decodeFingerprint(fingerprint);
  const decodedReport = decodeReport(origin, report);
  if (decodedFingerprint === null || decodedReport === null || !Array.isArray(records)) return null;
  const decoded: HistoryRecord[] = [];
  for (const row of records) {
    const record = decodeRecord(origin, row);
    if (record === null) return null;
    decoded.push(record);
  }
  return {
    fingerprint: decodedFingerprint,
    report: decodedReport,
    records: decoded,
    files: decodeFiles(origin, files),
  };
}

/** Lenient: a malformed file cache costs a re-read of those files, not the whole origin. */
function decodeFiles(origin: Origin, value: unknown): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 4) return new Map();
    const [path, size, mtimeMs, rows] = item as unknown[];
    if (typeof path !== "string" || !isNumber(size) || !isNumber(mtimeMs) || !Array.isArray(rows))
      return new Map();
    const records: HistoryRecord[] = [];
    for (const row of rows) {
      const record = decodeRecord(origin, row);
      if (record === null) return new Map();
      records.push(record);
    }
    out.set(path, { size, mtimeMs, records });
  }
  return out;
}

/** Never throws. A missing, unreadable or corrupt file is an empty cache, rebuilt by the next scan. */
export async function loadCache(path: string, maxBytes = MAX_CACHE_BYTES): Promise<CacheData> {
  const cache = emptyCache();
  let parsed: unknown;
  try {
    if ((await statFile(path)).size > maxBytes) return cache;
    parsed = parseJsonSafely(await readFile(path, "utf8"));
  } catch {
    return cache;
  }
  if (typeof parsed !== "object" || parsed === null) return cache;
  const { version, origins } = parsed as Record<string, unknown>;
  if (version !== 1 || typeof origins !== "object" || origins === null) return cache;
  for (const origin of ORIGINS) {
    const entry = decodeEntry(origin, (origins as Record<string, unknown>)[origin]);
    if (entry !== null) cache.origins[origin] = entry;
  }
  return cache;
}

/** Drops rows older than the retention cutoff, and file entries last touched before it. */
export function pruneEntry(entry: OriginEntry, cutoffMs: number): OriginEntry {
  const files = new Map<string, FileEntry>();
  for (const [path, file] of entry.files) {
    if (file.mtimeMs < cutoffMs) continue;
    const kept = file.records.filter((record) => record.at >= cutoffMs);
    files.set(path, kept.length === file.records.length ? file : { ...file, records: kept });
  }
  return { ...entry, records: entry.records.filter((record) => record.at >= cutoffMs), files };
}

/** Writes to a temp file in the same directory, then renames over the target. */
export async function saveCache(path: string, cache: CacheData): Promise<void> {
  const origins: Record<string, unknown> = {};
  for (const origin of ORIGINS) {
    const entry = cache.origins[origin];
    if (entry === undefined) continue;
    origins[origin] = {
      fingerprint: entry.fingerprint,
      report: { status: entry.report.status, files: entry.report.files, note: entry.report.note },
      records: entry.records.map(encodeRecord),
      files: [...entry.files].map(([filePath, file]) => [
        filePath,
        file.size,
        file.mtimeMs,
        file.records.map(encodeRecord),
      ]),
    };
  }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, origins }), { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}
