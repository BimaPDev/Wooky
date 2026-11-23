import path from "node:path";

import {
  ImportTuning,
  type HistoryFs,
  type HistoryReader,
  type HistoryReaderContext,
  type HistoryRecord,
  type HistorySourceReport,
} from "../history-reader.ts";
import {
  isMissingError,
  openReadOnlyDatabase,
  type OpenDatabase,
  type ReadOnlyDb,
} from "./cursor.ts";
import { antigravityDataDirs } from "./paths.ts";

export interface AntigravityReaderOptions {
  openDatabase?: OpenDatabase;
}

const MAX_WALK_DEPTH = 8;
const GENERATION_PAGE = 1;
const STEP_PAGE = 64;
const SKIP_DB_NAMES = new Set(["conversation_summaries.db"]);

/** Numeric ids Antigravity stores instead of a model string. */
const MODEL_IDS: Readonly<Record<number, string>> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1016: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1047: "gemini-3-flash-preview",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1084: "gemini-3-flash-preview",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
};

type ProtoMap = Map<number, unknown[]>;

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = bytes[offset];
    if (byte === undefined) return null;
    offset += 1;
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        return { value: Number.MAX_SAFE_INTEGER, next: offset };
      return { value: Number(value), next: offset };
    }
  }
  return null;
}

/** Length-delimited and varint protobuf fields only; other wire types are skipped. */
export function decodeProtobuf(bytes: Uint8Array): ProtoMap {
  const result: ProtoMap = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (tag === null) break;
    offset = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field === 0) break;
    let value: unknown;
    if (wire === 0) {
      const number = readVarint(bytes, offset);
      if (number === null) break;
      offset = number.next;
      value = number.value;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (length === null) break;
      offset = length.next;
      if (length.value > bytes.length - offset) break;
      value = bytes.subarray(offset, offset + length.value);
      offset += length.value;
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (offset + width > bytes.length) break;
      offset += width;
      continue;
    } else {
      break;
    }
    const entries = result.get(field) ?? [];
    entries.push(value);
    result.set(field, entries);
  }
  return result;
}

function numberAt(message: ProtoMap, field: number): number {
  const entry = message.get(field)?.[0];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
}

function bytesAt(message: ProtoMap, field: number): Uint8Array | undefined {
  const entry = message.get(field)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
}

function nested(message: ProtoMap, field: number): ProtoMap {
  const bytes = bytesAt(message, field);
  return bytes === undefined ? new Map() : decodeProtobuf(bytes);
}

function textAt(message: ProtoMap, field: number): string {
  const bytes = bytesAt(message, field);
  if (bytes === undefined) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return "";
  }
}

function timestampMs(message: ProtoMap): number | null {
  const seconds = numberAt(message, 1);
  if (seconds <= 0) return null;
  return seconds * 1000 + Math.floor(numberAt(message, 2) / 1e6);
}

function modelName(name: string): string {
  if (name === "") return "";
  const normalized = name
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
    .replace(/\s+/g, "-");
  if (normalized.startsWith("claude-")) {
    return normalized
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
      .replaceAll(".", "-");
  }
  return normalized;
}

function isConcreteModel(model: string): boolean {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

interface ParsedUsage {
  modelId: number;
  totals: UsageTotals;
  keys: string[];
}

interface ParsedEntry {
  idx: number;
  model: string;
  modelId: number;
  timestampMs: number | null;
  usages: ParsedUsage[];
}

function parseUsage(usage: ProtoMap): ParsedUsage | null {
  const output = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
  const totals: UsageTotals = {
    input: numberAt(usage, 2),
    cacheRead: numberAt(usage, 5),
    cacheWrite: numberAt(usage, 4),
    output,
    reasoning: Math.min(output, numberAt(usage, 9)),
  };
  if (totals.input + totals.cacheRead + totals.cacheWrite + totals.output === 0) return null;
  const keys = [11, 12, 7].flatMap((field) => {
    const id = textAt(usage, field);
    return id === "" ? [] : [`antigravity:${field}:${id}`];
  });
  return { modelId: numberAt(usage, 1), totals, keys };
}

function collectUsages(data: ProtoMap, usageField: number, retryField: number): ParsedUsage[] {
  const usages: ParsedUsage[] = [];
  const primary = bytesAt(data, usageField);
  if (primary !== undefined) {
    const parsed = parseUsage(decodeProtobuf(primary));
    if (parsed !== null) usages.push(parsed);
  }
  for (const retry of data.get(retryField) ?? []) {
    if (!(retry instanceof Uint8Array)) continue;
    const nestedUsage = bytesAt(decodeProtobuf(retry), 2);
    if (nestedUsage === undefined) continue;
    const parsed = parseUsage(decodeProtobuf(nestedUsage));
    if (parsed !== null) usages.push(parsed);
  }
  return usages;
}

function pickModel(names: string[], modelId: number): string {
  const concrete = names.find(isConcreteModel);
  if (concrete !== undefined) return concrete;
  const mapped = MODEL_IDS[modelId];
  if (mapped !== undefined) return mapped;
  return names.find((name) => name !== "" && !/^model[_-]/.test(name)) ?? "";
}

/** Generation `gen_metadata.data` blob. */
export function parseGenerationMetadata(bytes: Uint8Array): ParsedEntry | null {
  const root = decodeProtobuf(bytes);
  if (bytesAt(root, 1) === undefined) return null;
  const data = nested(root, 1);
  const names = [textAt(data, 19), textAt(data, 21)].map(modelName);
  const usages = collectUsages(data, 4, 17);
  const modelId = numberAt(data, 3) || (usages[0]?.modelId ?? 0);
  return {
    idx: 0,
    model: pickModel(names, modelId),
    modelId,
    timestampMs: timestampMs(nested(nested(data, 9), 4)),
    usages,
  };
}

/** Step `steps.metadata` blob. */
export function parseStepMetadata(bytes: Uint8Array): ParsedEntry | null {
  const data = decodeProtobuf(bytes);
  const model = nested(data, 24);
  const names = [textAt(model, 12), textAt(model, 8)].map(modelName);
  const usages = collectUsages(data, 9, 28);
  const modelId = numberAt(model, 1) || (usages[0]?.modelId ?? 0);
  return {
    idx: 0,
    model: pickModel(names, modelId),
    modelId,
    timestampMs: timestampMs(nested(data, 8)) ?? timestampMs(nested(data, 1)),
    usages,
  };
}

function parseTrajectoryTimestamp(bytes: Uint8Array): number | null {
  return timestampMs(nested(decodeProtobuf(bytes), 2));
}

interface Candidate {
  record: HistoryRecord;
  keys: string[];
  modelQuality: number;
}

function mergeCandidates(candidates: readonly Candidate[]): HistoryRecord[] {
  if (candidates.length === 0) return [];
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    let cursor = index;
    while (cursor !== root) {
      const next = parent[cursor] ?? cursor;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const records = candidates.map((candidate) => ({ ...candidate.record }));
  const quality = candidates.map((candidate) => candidate.modelQuality);
  const identities = new Map<string, number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) {
        const a = find(index);
        const b = find(existing);
        if (a !== b) {
          parent[b] = a;
          const left = records[a];
          const right = records[b];
          if (left !== undefined && right !== undefined) {
            left.inputTokens = Math.max(left.inputTokens, right.inputTokens);
            left.cacheReadTokens = Math.max(left.cacheReadTokens, right.cacheReadTokens);
            left.cacheWriteTokens = Math.max(left.cacheWriteTokens, right.cacheWriteTokens);
            left.outputTokens = Math.max(left.outputTokens, right.outputTokens);
            if (right.reasoningTokens !== undefined) {
              left.reasoningTokens = Math.max(left.reasoningTokens ?? 0, right.reasoningTokens);
            }
            if ((quality[b] ?? 0) > (quality[a] ?? 0)) {
              left.model = right.model;
              quality[a] = quality[b] ?? 0;
            }
            if (right.at < left.at) left.at = right.at;
          }
        }
      }
      identities.set(key, find(index));
    }
  }
  const seen = new Set<number>();
  const out: HistoryRecord[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const root = find(index);
    if (seen.has(root)) continue;
    seen.add(root);
    const record = records[root];
    if (record !== undefined) out.push(record);
  }
  return out;
}

function tableNames(db: ReadOnlyDb): Set<string> {
  return new Set(
    db
      .all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .flatMap((row) => (typeof row["name"] === "string" ? [row["name"]] : [])),
  );
}

function pageRows(
  db: ReadOnlyDb,
  sql: string,
  page: number,
  read: (blob: Uint8Array) => ParsedEntry | null,
): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let after = 0;
  for (;;) {
    const rows = db.all(sql, [after, page]);
    for (const row of rows) {
      const idx = row["idx"];
      const data = row["data"];
      if (typeof idx !== "number" || !(data instanceof Uint8Array)) continue;
      const parsed = read(data);
      if (parsed === null) continue;
      parsed.idx = idx;
      entries.push(parsed);
    }
    if (rows.length < page) break;
    const last = rows[rows.length - 1]?.["row_id"];
    if (typeof last !== "number") break;
    after = last;
  }
  return entries.sort((a, b) => a.idx - b.idx);
}

export function readAntigravityDatabase(
  db: ReadOnlyDb,
  sessionKey: string,
  fallbackAt: number,
  sinceMs: number,
  untilMs: number,
): HistoryRecord[] {
  const tables = tableNames(db);
  if (!tables.has("gen_metadata") && !tables.has("steps")) return [];
  const generations = tables.has("gen_metadata")
    ? pageRows(
        db,
        "SELECT rowid AS row_id, idx, data FROM gen_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?",
        GENERATION_PAGE,
        parseGenerationMetadata,
      )
    : [];
  let trajectoryAt: number | null = null;
  if (tables.has("trajectory_metadata_blob")) {
    for (const row of db.all("SELECT data FROM trajectory_metadata_blob")) {
      const data = row["data"];
      if (!(data instanceof Uint8Array)) continue;
      trajectoryAt = parseTrajectoryTimestamp(data);
      if (trajectoryAt !== null) break;
    }
  }
  const steps = tables.has("steps")
    ? pageRows(
        db,
        "SELECT rowid AS row_id, idx, metadata AS data FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
        STEP_PAGE,
        parseStepMetadata,
      )
    : [];

  const remembered = new Map<number, string>();
  for (const entry of [...generations, ...steps]) {
    if (entry.modelId > 0 && isConcreteModel(entry.model))
      remembered.set(entry.modelId, entry.model);
  }

  const generationByIdx = new Map(generations.map((entry) => [entry.idx, entry]));
  const candidates: Candidate[] = [];
  const sources: Array<["step" | "generation", ParsedEntry[]]> = [
    ["step", steps],
    ["generation", generations],
  ];
  for (const [source, entries] of sources) {
    for (const [index, entry] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const modelId = usage.modelId || entry.modelId;
        const generation = source === "step" ? generationByIdx.get(entry.idx) : undefined;
        const mapped = MODEL_IDS[modelId] ?? remembered.get(modelId) ?? "";
        const model =
          (isConcreteModel(entry.model) ? entry.model : "") ||
          (generation !== undefined && isConcreteModel(generation.model) ? generation.model : "") ||
          mapped ||
          entry.model ||
          "antigravity-unknown";
        const at = entry.timestampMs ?? trajectoryAt ?? fallbackAt;
        if (at < sinceMs || at >= untilMs) continue;
        const keys = usage.keys;
        candidates.push({
          keys,
          modelQuality: isConcreteModel(model) ? 4 : model ? 1 : 0,
          record: {
            origin: "antigravity",
            model,
            sessionKey,
            at,
            inputTokens: usage.totals.input,
            cacheReadTokens: usage.totals.cacheRead,
            cacheWriteTokens: usage.totals.cacheWrite,
            outputTokens: usage.totals.output,
            ...(usage.totals.reasoning > 0 ? { reasoningTokens: usage.totals.reasoning } : {}),
            dedupeKey: keys[0] ?? `antigravity:${sessionKey}:${source}:${index}:${usageIndex}`,
          },
        });
      }
    }
  }
  return mergeCandidates(candidates);
}

async function directoryExists(fs: HistoryFs, dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function conversationDirs(fs: HistoryFs, roots: readonly string[]): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const conversations = path.join(root, "conversations");
    const dir = (await directoryExists(fs, conversations)) ? conversations : root;
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

async function findDatabases(
  fs: HistoryFs,
  roots: readonly string[],
  signal: AbortSignal,
): Promise<{ files: { path: string; mtimeMs: number }[]; failed: number }> {
  const files: { path: string; mtimeMs: number }[] = [];
  let failed = 0;
  const pending: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  while (pending.length > 0 && !signal.aborted) {
    const next = pending.pop();
    if (next === undefined) break;
    const { dir, depth } = next;
    let names: readonly string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isMissingError(error) && depth === 0) continue;
      failed += 1;
      continue;
    }
    for (const name of names) {
      if (signal.aborted) break;
      if (name.endsWith("-wal") || name.endsWith("-shm")) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isDirectory()) {
          if (depth < MAX_WALK_DEPTH) pending.push({ dir: full, depth: depth + 1 });
        } else if (stat.isFile() && name.endsWith(".db") && !SKIP_DB_NAMES.has(name)) {
          files.push({ path: full, mtimeMs: stat.mtimeMs });
        }
      } catch {
        failed += 1;
      }
    }
  }
  return { files, failed };
}

export function createAntigravityHistoryReader(
  options: AntigravityReaderOptions = {},
): HistoryReader {
  const openDatabase = options.openDatabase ?? openReadOnlyDatabase;
  return {
    origin: "antigravity",
    async read(ctx: HistoryReaderContext) {
      const dirs = await conversationDirs(ctx.fs, antigravityDataDirs(ctx));
      let found: Awaited<ReturnType<typeof findDatabases>>;
      try {
        found = await findDatabases(ctx.fs, dirs, ctx.signal);
      } catch {
        return {
          records: [],
          report: {
            origin: "antigravity",
            status: "failed",
            files: 0,
            note: "Antigravity history could not be listed.",
          } satisfies HistorySourceReport,
        };
      }

      const notes: string[] = [];
      if (found.files.length === 0 && found.failed === 0) {
        return {
          records: [],
          report: {
            origin: "antigravity",
            status: "missing",
            files: 0,
            note: "No Antigravity conversation history found.",
          } satisfies HistorySourceReport,
        };
      }

      const cutoff = ctx.sinceMs - ImportTuning.mtimeSlackMs;
      const candidates = found.files
        .filter((file) => file.mtimeMs >= cutoff)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (candidates.length > ImportTuning.filesPerScan) {
        notes.push("Some Antigravity databases were left out to bound the scan.");
      }

      const records: HistoryRecord[] = [];
      let scanned = 0;
      let unreadable = found.failed;
      for (const file of candidates.slice(0, ImportTuning.filesPerScan)) {
        if (ctx.signal.aborted) break;
        let db: ReadOnlyDb;
        try {
          db = openDatabase(file.path);
        } catch {
          unreadable += 1;
          continue;
        }
        try {
          const sessionKey = path.basename(file.path, ".db");
          const rows = readAntigravityDatabase(
            db,
            sessionKey,
            Math.round(file.mtimeMs),
            ctx.sinceMs,
            ctx.untilMs,
          );
          scanned += 1;
          records.push(...rows);
        } catch {
          unreadable += 1;
        } finally {
          try {
            db.close();
          } catch {
            // Closing a read-only handle failing changes nothing for the scan.
          }
        }
      }

      if (ctx.signal.aborted) notes.push("Scan was cancelled.");
      if (unreadable > 0) notes.push(`${unreadable} Antigravity databases could not be read.`);
      return {
        records,
        report: {
          origin: "antigravity",
          status: notes.length > 0 ? "partial" : "ok",
          files: scanned,
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        } satisfies HistorySourceReport,
      };
    },
  };
}

export const antigravityHistoryReader: HistoryReader = createAntigravityHistoryReader();
