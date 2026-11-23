import type { HistoryRecord } from "../history-reader.ts";
import {
  ImportTuning,
  type HistoryReader,
  type HistoryReaderContext,
  type HistorySourceReport,
} from "../history-reader.ts";
import { claudeConfigDir } from "./paths.ts";

const SYNTHETIC_MODEL = "<synthetic>";
const USAGE_MARKER = '"usage"';
const READ_CHUNK_BYTES = 256 * 1024;

function tokenCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function buildDedupeKey(messageId: string | null, requestId: string | null): string | undefined {
  if (messageId === null && requestId === null) return undefined;
  return `${messageId ?? ""}:${requestId ?? ""}`;
}

function parseAssistantLine(line: string, sinceMs: number, untilMs: number): HistoryRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const entry = parsed as Record<string, unknown>;
  if (entry.type !== "assistant") return null;

  const message = entry.message;
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const at = parseTimestampMs(entry.timestamp);
  if (at === null || at < sinceMs || at >= untilMs) return null;

  const model = typeof messageRecord.model === "string" ? messageRecord.model : "";
  if (model.length === 0 || model === SYNTHETIC_MODEL) return null;

  const sessionKey = typeof entry.sessionId === "string" ? entry.sessionId : "";
  if (sessionKey.length === 0) return null;

  const messageId = typeof messageRecord.id === "string" ? messageRecord.id : null;
  const requestId = typeof entry.requestId === "string" ? entry.requestId : null;

  const cost = entry.costUSD;
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
  const cacheWrite = tokenCount(usageRecord.cache_creation_input_tokens);
  const cacheWrite1h = cacheWrite1hTokens(usageRecord.cache_creation, cacheWrite);

  return {
    origin: "claude",
    model,
    sessionKey,
    at,
    inputTokens: tokenCount(usageRecord.input_tokens),
    cacheReadTokens: tokenCount(usageRecord.cache_read_input_tokens),
    cacheWriteTokens: Math.max(cacheWrite, cacheWrite1h),
    ...(cacheWrite1h > 0 ? { cacheWrite1hTokens: cacheWrite1h } : {}),
    outputTokens: tokenCount(usageRecord.output_tokens),
    reportedCostUsd,
    dedupeKey: buildDedupeKey(messageId, requestId),
  };
}

function cacheWrite1hTokens(split: unknown, cacheWrite: number): number {
  if (typeof split !== "object" || split === null || Array.isArray(split)) return 0;
  const tokens = tokenCount((split as Record<string, unknown>).ephemeral_1h_input_tokens);
  if (tokens <= 0) return 0;
  return cacheWrite > 0 ? Math.min(tokens, cacheWrite) : tokens;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

async function listJsonlFiles(
  dir: string,
  ctx: HistoryReaderContext,
  acc: string[],
): Promise<void> {
  if (ctx.signal.aborted) return;
  let names: readonly string[];
  try {
    names = await ctx.fs.readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const name of names) {
    if (ctx.signal.aborted) return;
    const child = `${dir}/${name}`;
    let info;
    try {
      info = await ctx.fs.stat(child);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (info.isDirectory()) {
      await listJsonlFiles(child, ctx, acc);
    } else if (info.isFile() && name.endsWith(".jsonl")) {
      acc.push(child);
    }
  }
}

export type ReadLinesTuning = {
  onPeakCarryBytes?: (peak: number) => void;
};

async function readLines(
  path: string,
  ctx: HistoryReaderContext,
  onOversizedLine: () => void,
  tuning?: ReadLinesTuning,
): Promise<string[]> {
  const data = await ctx.fs.readFile(path);
  const lines: string[] = [];
  let carry = new Uint8Array(0);
  let skipOversized = false;
  let peakCarry = 0;

  const trackPeak = () => {
    if (carry.byteLength > peakCarry) peakCarry = carry.byteLength;
  };

  const parseBuffered = (buffer: Uint8Array) => {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0x0a) {
        const lineBytes = buffer.subarray(start, i);
        if (lineBytes.byteLength > ImportTuning.maxLineBytes) {
          onOversizedLine();
        } else if (lineBytes.byteLength > 0) {
          lines.push(new TextDecoder().decode(lineBytes));
        }
        start = i + 1;
      }
    }
    return buffer.subarray(start);
  };

  for (let offset = 0; offset < data.byteLength || (offset === 0 && data.byteLength === 0);) {
    if (ctx.signal.aborted) break;
    const end = Math.min(offset + READ_CHUNK_BYTES, data.byteLength);
    const slice = data.subarray(offset, end);
    offset = end;

    if (skipOversized) {
      let newlineAt = -1;
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === 0x0a) {
          newlineAt = i;
          break;
        }
      }
      if (newlineAt === -1) continue;
      skipOversized = false;
      carry = Uint8Array.from(slice.subarray(newlineAt + 1));
      trackPeak();
      const tail = parseBuffered(carry);
      if (tail.byteLength > ImportTuning.maxLineBytes) {
        onOversizedLine();
        skipOversized = true;
        carry = new Uint8Array(0);
      } else {
        carry = Uint8Array.from(tail);
      }
      trackPeak();
      if (offset >= data.byteLength) break;
      continue;
    }

    carry = Uint8Array.from(concatBytes(carry, slice));
    trackPeak();
    const tail = parseBuffered(carry);
    if (tail.byteLength > ImportTuning.maxLineBytes) {
      onOversizedLine();
      skipOversized = true;
      carry = new Uint8Array(0);
    } else {
      carry = Uint8Array.from(tail);
    }
    trackPeak();

    if (offset >= data.byteLength) break;
  }

  if (!ctx.signal.aborted && !skipOversized && carry.byteLength > 0) {
    if (carry.byteLength > ImportTuning.maxLineBytes) {
      onOversizedLine();
    } else {
      lines.push(new TextDecoder().decode(carry));
    }
  }

  tuning?.onPeakCarryBytes?.(peakCarry);
  return lines;
}

/** @internal Test seam for chunked line parsing and buffer bounds. */
export const readLinesForTest = readLines;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export const claudeHistoryReader: HistoryReader = {
  origin: "claude",
  async read(ctx) {
    const projectsDir = `${claudeConfigDir(ctx)}/projects`;
    let projectStat;
    try {
      projectStat = await ctx.fs.stat(projectsDir);
    } catch (error) {
      if (isEnoent(error)) {
        const report: HistorySourceReport = { origin: "claude", status: "missing", files: 0 };
        return { records: [], report };
      }
      throw error;
    }
    if (!projectStat.isDirectory()) {
      const report: HistorySourceReport = { origin: "claude", status: "missing", files: 0 };
      return { records: [], report };
    }

    const mtimeFloor = ctx.sinceMs - ImportTuning.mtimeSlackMs;
    const paths: string[] = [];
    await listJsonlFiles(projectsDir, ctx, paths);
    paths.sort();

    const records: HistoryRecord[] = [];
    let filesScanned = 0;
    let partial = false;

    for (const path of paths) {
      if (ctx.signal.aborted) break;
      if (filesScanned >= ImportTuning.filesPerScan) {
        partial = true;
        break;
      }

      let fileStat;
      try {
        fileStat = await ctx.fs.stat(path);
      } catch (error) {
        if (isEnoent(error)) continue;
        partial = true;
        continue;
      }
      if (!fileStat.isFile()) continue;
      if (fileStat.mtimeMs < mtimeFloor) continue;

      filesScanned++;

      const fileKey = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
      const cached = ctx.fileCache?.get(path, fileKey);
      if (cached !== undefined) {
        records.push(...cached);
        continue;
      }

      let filePartial = false;
      const markPartial = () => {
        filePartial = true;
      };

      const fileRecords: HistoryRecord[] = [];
      let lines: string[];
      try {
        lines = await readLines(path, ctx, markPartial);
      } catch (error) {
        if (isEnoent(error)) continue;
        partial = true;
        continue;
      }
      for (const line of lines) {
        if (ctx.signal.aborted) break;
        if (line.length > ImportTuning.maxLineBytes) {
          filePartial = true;
          continue;
        }
        if (!line.includes(USAGE_MARKER)) continue;
        const record = parseAssistantLine(line, ctx.sinceMs, ctx.untilMs);
        if (record) fileRecords.push(record);
      }

      if (filePartial) partial = true;
      if (!filePartial) ctx.fileCache?.set(path, fileKey, fileRecords);
      records.push(...fileRecords);
    }

    if (ctx.signal.aborted) {
      partial = true;
    }

    const status = partial ? "partial" : "ok";

    const report: HistorySourceReport = {
      origin: "claude",
      status,
      files: filesScanned,
      ...(partial ? { note: "Scan stopped before all transcript files were read." } : {}),
    };

    return { records, report };
  },
};
