import path from "node:path";

import {
  ImportTuning,
  type HistoryFs,
  type HistoryReader,
  type HistoryReaderContext,
  type HistoryRecord,
  type HistorySourceReport,
} from "../history-reader.ts";

const MAX_WALK_DEPTH = 6;
const NEWLINE = 10;
/** Copied fork history is restamped in a burst; real child usage follows a model turn seconds later. */
const FORK_COPY_MAX_GAP_MS = 1000;
const MARKERS = [
  Buffer.from('"token_count"'),
  Buffer.from('"session_meta"'),
  Buffer.from('"turn_context"'),
];

interface Counters {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

const COUNTER_KEYS = ["input", "cached", "cacheWrite", "output", "reasoning"] as const;

function count(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function readCounters(value: unknown): Counters | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw["input_tokens"] !== "number" || typeof raw["output_tokens"] !== "number") {
    return null;
  }
  const counters = {
    input: count(raw["input_tokens"]),
    cached: count(raw["cached_input_tokens"]),
    cacheWrite: count(raw["cache_write_input_tokens"]),
    output: count(raw["output_tokens"]),
    reasoning: count(raw["reasoning_output_tokens"]),
  };
  if (COUNTER_KEYS.some((key) => counters[key] === null)) return null;
  return counters as Counters;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isForkMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  return (
    typeof spawn === "object" &&
    spawn !== null &&
    typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string"
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface SessionState {
  sessionKey: string;
  model: string;
  baseline: Counters | null;
  lastSignature: string | null;
  sawMeta: boolean;
  suppressing: boolean;
  anchorMs: number;
  malformed: number;
}

function sameCounters(a: Counters, b: Counters): boolean {
  return COUNTER_KEYS.every((key) => a[key] === b[key]);
}

function deltaOf(current: Counters, previous: Counters | null): Counters {
  const out = {} as Counters;
  for (const key of COUNTER_KEYS) out[key] = Math.max(0, current[key] - (previous?.[key] ?? 0));
  return out;
}

function toRecord(state: SessionState, at: number, delta: Counters): HistoryRecord | null {
  if (delta.input + delta.output === 0) return null;
  const uncached = Math.max(0, delta.input - delta.cached - delta.cacheWrite);
  return {
    origin: "codex",
    model: state.model || "unknown",
    sessionKey: state.sessionKey,
    at,
    inputTokens: uncached,
    cacheReadTokens: delta.cached,
    cacheWriteTokens: delta.cacheWrite,
    outputTokens: delta.output,
    ...(delta.reasoning > 0 ? { reasoningTokens: delta.reasoning } : {}),
    dedupeKey: `codex:${state.sessionKey}:${at}:${state.model}:${delta.input}:${delta.cached}:${delta.cacheWrite}:${delta.output}`,
  };
}

/** Applies one parsed event to the session state; returns the usage delta it carries, if any. */
function applyEvent(state: SessionState, event: unknown): { at: number; delta: Counters } | null {
  const record = object(event);
  const payload = object(record?.["payload"]);
  if (record === null || payload === null) return null;
  const type = record["type"];

  if (type === "session_meta") {
    if (state.sawMeta) return null;
    state.sawMeta = true;
    const id = payload["id"] ?? payload["session_id"];
    if (typeof id === "string" && id.length > 0) state.sessionKey = id;
    const at = parseTime(record["timestamp"]);
    if (at !== null && isForkMeta(payload)) {
      state.suppressing = true;
      state.anchorMs = at;
    }
    return null;
  }

  if (type === "turn_context") {
    if (typeof payload["model"] === "string" && payload["model"].length > 0) {
      state.model = payload["model"];
    }
    return null;
  }

  if (payload["type"] !== "token_count") return null;
  const info = object(payload["info"]);
  if (info === null) return null;
  const at = parseTime(record["timestamp"]);
  const cumulative = readCounters(info["total_token_usage"]);
  const last = readCounters(info["last_token_usage"]);
  const hasCumulative =
    info["total_token_usage"] !== undefined && info["total_token_usage"] !== null;
  if (at === null || (hasCumulative && cumulative === null) || (!hasCumulative && last === null)) {
    state.malformed += 1;
    return null;
  }

  if (state.suppressing) {
    if (at - state.anchorMs < FORK_COPY_MAX_GAP_MS) {
      state.anchorMs = at;
      if (cumulative !== null) state.baseline = cumulative;
      state.lastSignature = last === null ? null : JSON.stringify(last);
      return null;
    }
    state.suppressing = false;
  }

  if (cumulative === null) {
    if (last === null) return null;
    const signature = JSON.stringify(last);
    if (signature === state.lastSignature) return null;
    state.lastSignature = signature;
    return { at, delta: last };
  }

  const previous = state.baseline;
  if (previous === null) {
    state.baseline = cumulative;
    state.lastSignature = last === null ? null : JSON.stringify(last);
    return { at, delta: cumulative };
  }
  if (COUNTER_KEYS.some((key) => cumulative[key] < previous[key])) {
    // Genuine reset: cumulative matches this request’s last usage. A replayed older snapshot keeps the prior baseline.
    if (last !== null && sameCounters(cumulative, last)) {
      state.baseline = cumulative;
      state.lastSignature = JSON.stringify(last);
      return { at, delta: cumulative };
    }
    return null;
  }
  state.baseline = cumulative;
  state.lastSignature = last === null ? null : JSON.stringify(last);
  return { at, delta: deltaOf(cumulative, previous) };
}

function* lineRanges(buffer: Buffer): Generator<[number, number]> {
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(NEWLINE, start);
    if (end === -1) end = buffer.length;
    yield [start, end];
    start = end + 1;
  }
}

interface FileResult {
  records: HistoryRecord[];
  malformed: number;
  oversized: number;
}

function parseRollout(buffer: Buffer, stem: string, ctx: HistoryReaderContext): FileResult {
  const state: SessionState = {
    sessionKey: stem,
    model: "",
    baseline: null,
    lastSignature: null,
    sawMeta: false,
    suppressing: false,
    anchorMs: 0,
    malformed: 0,
  };
  const records: HistoryRecord[] = [];
  let oversized = 0;
  for (const [start, end] of lineRanges(buffer)) {
    if (ctx.signal.aborted) break;
    if (end - start === 0) continue;
    const line = buffer.subarray(start, end);
    if (!MARKERS.some((marker) => line.includes(marker))) continue;
    if (line.length > ImportTuning.maxLineBytes) {
      oversized += 1;
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line.toString("utf8"));
    } catch {
      state.malformed += 1;
      continue;
    }
    const emitted = applyEvent(state, event);
    if (emitted === null) continue;
    if (emitted.at < ctx.sinceMs || emitted.at >= ctx.untilMs) continue;
    const mapped = toRecord(state, emitted.at, emitted.delta);
    if (mapped !== null) records.push(mapped);
  }
  return { records, malformed: state.malformed, oversized };
}

async function listRollouts(
  fs: HistoryFs,
  root: string,
  signal: AbortSignal,
): Promise<{ files: { path: string; mtimeMs: number }[]; failed: number }> {
  const files: { path: string; mtimeMs: number }[] = [];
  let failed = 0;
  const pending: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (pending.length > 0 && !signal.aborted) {
    const next = pending.pop();
    if (next === undefined) break;
    const { dir, depth } = next;
    let names: readonly string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (dir === root) throw error;
      failed += 1;
      continue;
    }
    for (const name of names) {
      if (signal.aborted) break;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          if (depth < MAX_WALK_DEPTH) pending.push({ dir: full, depth: depth + 1 });
        } else if (name.endsWith(".jsonl") && stat.isFile()) {
          files.push({ path: full, mtimeMs: stat.mtimeMs });
        }
      } catch {
        failed += 1;
      }
    }
  }
  return { files, failed };
}

function codexHome(ctx: HistoryReaderContext): string {
  const configured = ctx.env["CODEX_HOME"];
  return configured && path.isAbsolute(configured) ? configured : path.join(ctx.homeDir, ".codex");
}

function isMissing(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

export const codexHistoryReader: HistoryReader = {
  origin: "codex",
  async read(ctx: HistoryReaderContext) {
    let found: Awaited<ReturnType<typeof listRollouts>>;
    try {
      found = await listRollouts(ctx.fs, path.join(codexHome(ctx), "sessions"), ctx.signal);
    } catch (error) {
      const missing = isMissing(error);
      return {
        records: [],
        report: {
          origin: "codex",
          status: missing ? "missing" : "failed",
          files: 0,
          note: missing
            ? "No Codex session history found."
            : "Codex session history could not be listed.",
        } satisfies HistorySourceReport,
      };
    }

    const cutoff = ctx.sinceMs - ImportTuning.mtimeSlackMs;
    const candidates = found.files
      .filter((file) => file.mtimeMs >= cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const truncated = candidates.length > ImportTuning.filesPerScan;
    const records: HistoryRecord[] = [];
    let scanned = 0;
    let unreadable = found.failed;
    let malformed = 0;
    let oversized = 0;
    for (const file of candidates.slice(0, ImportTuning.filesPerScan)) {
      if (ctx.signal.aborted) break;
      let data: Uint8Array;
      try {
        data = await ctx.fs.readFile(file.path);
      } catch {
        unreadable += 1;
        continue;
      }
      scanned += 1;
      const stem = path.basename(file.path, ".jsonl");
      const parsed = parseRollout(
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        stem,
        ctx,
      );
      for (const record of parsed.records) records.push(record);
      malformed += parsed.malformed;
      oversized += parsed.oversized;
    }

    const notes: string[] = [];
    if (ctx.signal.aborted) notes.push("Scan was cancelled.");
    if (unreadable > 0) notes.push(`${unreadable} Codex files could not be read.`);
    if (malformed > 0) notes.push(`${malformed} usage entries were unreadable.`);
    if (oversized > 0) notes.push(`${oversized} oversized lines were skipped.`);
    if (truncated) notes.push("Some Codex files were left out to bound the scan.");
    return {
      records,
      report: {
        origin: "codex",
        status: notes.length > 0 ? "partial" : "ok",
        files: scanned,
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      } satisfies HistorySourceReport,
    };
  },
};
