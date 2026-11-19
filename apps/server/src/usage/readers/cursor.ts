import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  ImportTuning,
  type HistoryFs,
  type HistoryReader,
  type HistoryReaderContext,
  type HistoryRecord,
  type HistorySourceReport,
} from "../history-reader.ts";

/** The two calls a reader needs. A test injects an in-memory fixture behind it. */
export interface ReadOnlyDb {
  all(sql: string, params?: readonly (string | number)[]): Record<string, unknown>[];
  close(): void;
}

export type OpenDatabase = (path: string) => ReadOnlyDb;

export const openReadOnlyDatabase: OpenDatabase = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 250 });
  return {
    all: (sql, params = []) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    close: () => db.close(),
  };
};

export interface CursorReaderOptions {
  openDatabase?: OpenDatabase;
}

const MAX_WALK_DEPTH = 6;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function isMissingError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Reads a timestamp stored as ISO text, epoch ms or epoch seconds. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return parseTimestamp(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function tokenCount(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

async function findIndexDatabases(
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
        } else if (name === "index.db" && stat.isFile()) {
          files.push({ path: full, mtimeMs: stat.mtimeMs });
        }
      } catch {
        failed += 1;
      }
    }
  }
  return { files, failed };
}

interface CursorUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** `totalTokens` is input plus output on this corpus; any other relation is unknown drift. */
function readUsage(raw: unknown): CursorUsage | "drift" | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const usage = parsed as Record<string, unknown>;
  const input = tokenCount(usage["inputTokens"]);
  const output = tokenCount(usage["outputTokens"]);
  const cacheRead = tokenCount(usage["cacheReadTokens"]);
  const cacheWrite = tokenCount(usage["cacheWriteTokens"]);
  const reasoning = tokenCount(usage["reasoningTokens"]);
  const total = tokenCount(usage["totalTokens"]);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    reasoning === null ||
    total === null
  ) {
    return null;
  }
  if (usage["totalTokens"] !== undefined && total !== input + output) return "drift";
  return { input, output, cacheRead, cacheWrite, reasoning };
}

const TIME_COLUMNS = ["started_at", "created_at", "updated_at", "finished_at"] as const;

function planRunsQuery(columns: ReadonlySet<string>): string | null {
  if (!columns.has("usage_json")) return null;
  const times = TIME_COLUMNS.filter((name) => columns.has(name));
  if (times.length === 0 || !(columns.has("run_id") || columns.has("agent_id"))) return null;
  const picked = [
    `COALESCE(${times.join(", ")}) AS ts`,
    "usage_json",
    columns.has("model") ? "model" : "NULL AS model",
    columns.has("run_id") ? "run_id" : "NULL AS run_id",
    columns.has("agent_id") ? "agent_id" : "NULL AS agent_id",
  ];
  return `SELECT ${picked.join(", ")} FROM runs WHERE usage_json IS NOT NULL`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const ACCOUNT_CACHE_NAME = "usage-cursor-account-cache-v2.json";
const MAX_IDE_DB_BYTES = 64 * 1024 * 1024;

function accountCachePaths(ctx: HistoryReaderContext): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (dir === "" || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  const wookyHome = ctx.env["WOOKY_HOME"]?.trim();
  if (wookyHome && path.isAbsolute(wookyHome)) add(wookyHome);
  add(path.join(ctx.homeDir, ".t3", "userdata"));
  add(path.join(ctx.homeDir, ".wooky"));
  return dirs.map((dir) => path.join(dir, ACCOUNT_CACHE_NAME));
}

function interned(strings: readonly string[], value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < strings.length
  ) {
    const resolved = strings[value];
    return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  }
  return null;
}

function reportedCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function fingerprintKey(
  model: string,
  at: number,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
): string {
  return `cursor:${Math.round(at / 1000)}:${model}:${input}:${cacheRead}:${cacheWrite}:${output}`;
}

/** Cursor billed-account cache (version 2). Model and session ids may be interned. */
export function decodeCursorAccountCache(
  raw: unknown,
  sinceMs: number,
  untilMs: number,
): HistoryRecord[] {
  if (typeof raw !== "object" || raw === null) return [];
  const root = raw as Record<string, unknown>;
  if (root["version"] !== 2) return [];
  const strings = Array.isArray(root["strings"])
    ? root["strings"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const accounts = root["accounts"];
  if (typeof accounts !== "object" || accounts === null) return [];
  const records: HistoryRecord[] = [];
  for (const account of Object.values(accounts as Record<string, unknown>)) {
    if (typeof account !== "object" || account === null) continue;
    const rows = (account as Record<string, unknown>)["records"];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 8) continue;
      const at = parseTimestamp(row[0]);
      const model = interned(strings, row[1]) ?? "default";
      const session = interned(strings, row[2]) ?? model;
      const input = tokenCount(row[3]);
      const cacheRead = tokenCount(row[4]);
      const cacheWrite = tokenCount(row[5]);
      const output = tokenCount(row[6]);
      const cost = reportedCost(row[7]);
      const explicitKey = interned(strings, row[8]);
      if (
        at === null ||
        input === null ||
        cacheRead === null ||
        cacheWrite === null ||
        output === null
      ) {
        continue;
      }
      if (at < sinceMs || at >= untilMs) continue;
      if (input + cacheRead + cacheWrite + output === 0 && cost === undefined) continue;
      records.push({
        origin: "cursor",
        model,
        sessionKey: session,
        at,
        inputTokens: input,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        ...(cost === undefined ? {} : { reportedCostUsd: cost }),
        dedupeKey: explicitKey ?? fingerprintKey(model, at, input, cacheRead, cacheWrite, output),
      });
    }
  }
  return records;
}

function ideDatabasePaths(homeDir: string): string[] {
  return [
    path.join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
    path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
}

const IDE_BUBBLE_SQL =
  "SELECT key, json_extract(value, '$.tokenCount.inputTokens') AS input, json_extract(value, '$.tokenCount.outputTokens') AS output, json_extract(value, '$.tokenCount.cacheReadTokens') AS cache_read, json_extract(value, '$.tokenCount.cacheWriteTokens') AS cache_write, json_extract(value, '$.createdAt') AS created_at, json_extract(value, '$.modelInfo.modelName') AS model FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'";

export function readCursorIdeDatabase(
  db: ReadOnlyDb,
  sinceMs: number,
  untilMs: number,
): { records: HistoryRecord[]; skipped: number } {
  const tables = new Set(
    db
      .all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .flatMap((row) => (typeof row["name"] === "string" ? [row["name"]] : [])),
  );
  if (!tables.has("cursorDiskKV")) return { records: [], skipped: 0 };
  const records: HistoryRecord[] = [];
  let skipped = 0;
  for (const row of db.all(IDE_BUBBLE_SQL)) {
    const key = text(row["key"]);
    const at = parseTimestamp(row["created_at"]);
    const input = tokenCount(row["input"]);
    const output = tokenCount(row["output"]);
    const cacheRead = tokenCount(row["cache_read"]);
    const cacheWrite = tokenCount(row["cache_write"]);
    if (key === null || at === null || input === null || output === null) {
      skipped += 1;
      continue;
    }
    const read = cacheRead ?? 0;
    const write = cacheWrite ?? 0;
    if (input + output + read + write === 0) continue;
    if (at < sinceMs || at >= untilMs) continue;
    const session = key.split(":")[1] ?? key;
    const model = text(row["model"]) ?? "default";
    records.push({
      origin: "cursor",
      model,
      sessionKey: session,
      at,
      inputTokens: input,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      outputTokens: output,
      dedupeKey: fingerprintKey(model, at, input, read, write, output),
    });
  }
  return { records, skipped };
}

export function createCursorHistoryReader(options: CursorReaderOptions = {}): HistoryReader {
  const openDatabase = options.openDatabase ?? openReadOnlyDatabase;
  return {
    origin: "cursor",
    async read(ctx: HistoryReaderContext) {
      const records: HistoryRecord[] = [];
      const notes: string[] = [];
      let scanned = 0;
      let unreadable = 0;
      let skippedRows = 0;
      let drift = 0;
      let sawSource = false;

      for (const cachePath of accountCachePaths(ctx)) {
        if (ctx.signal.aborted) break;
        let stat;
        try {
          stat = await ctx.fs.stat(cachePath);
        } catch (error) {
          if (!isMissingError(error)) unreadable += 1;
          continue;
        }
        if (!stat.isFile()) continue;
        sawSource = true;
        try {
          const parsed: unknown = JSON.parse(
            new TextDecoder().decode(await ctx.fs.readFile(cachePath)),
          );
          const billed = decodeCursorAccountCache(parsed, ctx.sinceMs, ctx.untilMs);
          records.push(...billed);
          scanned += 1;
        } catch {
          unreadable += 1;
        }
      }

      const billedFingerprints = new Set(
        records.map((record) =>
          fingerprintKey(
            record.model,
            record.at,
            record.inputTokens,
            record.cacheReadTokens,
            record.cacheWriteTokens,
            record.outputTokens,
          ),
        ),
      );
      const billedSessions = new Set(records.map((record) => record.sessionKey));
      const localNeeded = billedFingerprints.size === 0;

      const root = path.join(ctx.homeDir, ".cursor", "projects");
      let found: Awaited<ReturnType<typeof findIndexDatabases>> | null = null;
      if (localNeeded) {
        try {
          found = await findIndexDatabases(ctx.fs, root, ctx.signal);
          sawSource = true;
        } catch (error) {
          if (!isMissingError(error)) {
            unreadable += 1;
            notes.push("Cursor project history could not be listed.");
          }
        }
      }

      if (localNeeded && found !== null) {
        unreadable += found.failed;
        const cutoff = ctx.sinceMs - ImportTuning.mtimeSlackMs;
        const candidates = found.files
          .filter((file) => file.mtimeMs >= cutoff)
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
        if (candidates.length > ImportTuning.filesPerScan) {
          notes.push("Some Cursor databases were left out to bound the scan.");
        }
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
            const columns = new Set(
              db.all("PRAGMA table_info(runs)").flatMap((row) => {
                const name = text(row["name"]);
                return name === null ? [] : [name];
              }),
            );
            const plan = planRunsQuery(columns);
            if (plan === null) {
              unreadable += 1;
              continue;
            }
            scanned += 1;
            for (const row of db.all(plan)) {
              if (ctx.signal.aborted) break;
              const at = parseTimestamp(row["ts"]);
              const usage = readUsage(row["usage_json"]);
              const session = text(row["agent_id"]) ?? text(row["run_id"]);
              if (usage === "drift") {
                drift += 1;
                continue;
              }
              if (at === null || usage === null || session === null) {
                skippedRows += 1;
                continue;
              }
              if (at < ctx.sinceMs || at >= ctx.untilMs) continue;
              const model = text(row["model"]) ?? "default";
              const inputTokens = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
              const runId = text(row["run_id"]);
              const shared = fingerprintKey(
                model,
                at,
                inputTokens,
                usage.cacheRead,
                usage.cacheWrite,
                usage.output,
              );
              if (billedFingerprints.has(shared) || billedSessions.has(session)) continue;
              const record: HistoryRecord = {
                origin: "cursor",
                model,
                sessionKey: session,
                at,
                inputTokens,
                cacheReadTokens: usage.cacheRead,
                cacheWriteTokens: usage.cacheWrite,
                outputTokens: usage.output,
                dedupeKey: runId === null ? shared : `cursor:${runId}`,
              };
              if (usage.reasoning > 0) record.reasoningTokens = usage.reasoning;
              records.push(record);
            }
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
      }

      for (const idePath of localNeeded ? ideDatabasePaths(ctx.homeDir) : []) {
        if (ctx.signal.aborted) break;
        let stat;
        try {
          stat = await ctx.fs.stat(idePath);
        } catch (error) {
          if (!isMissingError(error)) unreadable += 1;
          continue;
        }
        if (!stat.isFile()) continue;
        sawSource = true;
        if (stat.size > MAX_IDE_DB_BYTES) continue;
        let db: ReadOnlyDb;
        try {
          db = openDatabase(idePath);
        } catch {
          unreadable += 1;
          continue;
        }
        try {
          const ide = readCursorIdeDatabase(db, ctx.sinceMs, ctx.untilMs);
          skippedRows += ide.skipped;
          scanned += 1;
          for (const record of ide.records) {
            if (
              billedFingerprints.has(
                fingerprintKey(
                  record.model,
                  record.at,
                  record.inputTokens,
                  record.cacheReadTokens,
                  record.cacheWriteTokens,
                  record.outputTokens,
                ),
              ) ||
              billedSessions.has(record.sessionKey)
            ) {
              continue;
            }
            records.push(record);
          }
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
      if (unreadable > 0) notes.push(`${unreadable} Cursor databases could not be read.`);
      if (skippedRows > 0) notes.push(`${skippedRows} runs had unreadable usage.`);
      if (drift > 0)
        notes.push(`${drift} runs used an unrecognised token layout and were skipped.`);
      if (!sawSource) {
        return {
          records: [],
          report: {
            origin: "cursor",
            status: "missing",
            files: 0,
            note: "No Cursor project history found.",
          } satisfies HistorySourceReport,
        };
      }
      return {
        records,
        report: {
          origin: "cursor",
          status: notes.length > 0 ? "partial" : "ok",
          files: scanned,
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        } satisfies HistorySourceReport,
      };
    },
  };
}

export const cursorHistoryReader: HistoryReader = createCursorHistoryReader();
