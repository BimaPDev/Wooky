import type { HistoryRecord } from "../history-reader.ts";
import {
  ImportTuning,
  type HistoryReader,
  type HistoryReaderContext,
  type HistorySourceReport,
} from "../history-reader.ts";

const SYNTHETIC_MODEL = "<synthetic>";
const USAGE_MARKER = '"usage"';
const READ_CHUNK_BYTES = 256 * 1024;

function claudeConfigDir(ctx: HistoryReaderContext): string {
  const configured = ctx.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) return configured;
  return `${ctx.homeDir}/.claude`;
}

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

  return {
    origin: "claude",
    model,
    sessionKey,
    at,
    inputTokens: tokenCount(usageRecord.input_tokens),
    cacheReadTokens: tokenCount(usageRecord.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(usageRecord.cache_creation_input_tokens),
    outputTokens: tokenCount(usageRecord.output_tokens),
    reportedCostUsd,
    dedupeKey: buildDedupeKey(messageId, requestId),
  };
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
    const info = await ctx.fs.stat(child);
    if (info.isDirectory()) {
      await listJsonlFiles(child, ctx, acc);
    } else if (info.isFile() && name.endsWith(".jsonl")) {
      acc.push(child);
    }
  }
}

async function readLines(
  path: string,
  ctx: HistoryReaderContext,
  onOversizedLine: () => void,
): Promise<string[]> {
  const data = await ctx.fs.readFile(path);
  const lines: string[] = [];
  let carry = new Uint8Array(0);

  for (let offset = 0; offset < data.byteLength || (offset === 0 && data.byteLength === 0);) {
    if (ctx.signal.aborted) break;
    const end = Math.min(offset + READ_CHUNK_BYTES, data.byteLength);
    const slice = data.subarray(offset, end);
    offset = end;

    const combined = concatBytes(carry, slice);
    let start = 0;
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 0x0a) {
        const lineBytes = combined.subarray(start, i);
        if (lineBytes.byteLength > ImportTuning.maxLineBytes) {
          onOversizedLine();
        } else if (lineBytes.byteLength > 0) {
          lines.push(new TextDecoder().decode(lineBytes));
        }
        start = i + 1;
      }
    }

    const tail = combined.subarray(start);
    if (tail.byteLength > ImportTuning.maxLineBytes) {
      onOversizedLine();
      carry = new Uint8Array(0);
      let skipEnd = start;
      for (let i = start; i < combined.length; i++) {
        if (combined[i] === 0x0a) {
          skipEnd = i + 1;
          break;
        }
      }
      carry = Uint8Array.from(combined.subarray(skipEnd));
    } else {
      carry = Uint8Array.from(tail);
    }

    if (offset >= data.byteLength) break;
  }

  if (!ctx.signal.aborted && carry.byteLength > 0) {
    if (carry.byteLength > ImportTuning.maxLineBytes) {
      onOversizedLine();
    } else {
      lines.push(new TextDecoder().decode(carry));
    }
  }

  return lines;
}

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

      const fileStat = await ctx.fs.stat(path);
      if (!fileStat.isFile()) continue;
      if (fileStat.mtimeMs < mtimeFloor) continue;

      filesScanned++;
      let filePartial = false;
      const markPartial = () => {
        filePartial = true;
      };

      const fileRecords: HistoryRecord[] = [];
      const lines = await readLines(path, ctx, markPartial);
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
