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

export function createCursorHistoryReader(options: CursorReaderOptions = {}): HistoryReader {
  const openDatabase = options.openDatabase ?? openReadOnlyDatabase;
  return {
    origin: "cursor",
    async read(ctx: HistoryReaderContext) {
      const root = path.join(ctx.homeDir, ".cursor", "projects");
      let found: Awaited<ReturnType<typeof findIndexDatabases>>;
      try {
        found = await findIndexDatabases(ctx.fs, root, ctx.signal);
      } catch (error) {
        return {
          records: [],
          report: {
            origin: "cursor",
            status: isMissingError(error) ? "missing" : "failed",
            files: 0,
            note: isMissingError(error)
              ? "No Cursor project history found."
              : "Cursor project history could not be listed.",
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
      let skippedRows = 0;
      let drift = 0;

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
            const runId = text(row["run_id"]);
            records.push({
              origin: "cursor",
              model: text(row["model"]) ?? "default",
              sessionKey: session,
              at,
              inputTokens: Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite),
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheWrite,
              outputTokens: usage.output,
              ...(usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {}),
              ...(runId === null ? {} : { dedupeKey: `cursor:${runId}` }),
            });
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

      const notes: string[] = [];
      if (ctx.signal.aborted) notes.push("Scan was cancelled.");
      if (unreadable > 0) notes.push(`${unreadable} Cursor databases could not be read.`);
      if (skippedRows > 0) notes.push(`${skippedRows} runs had unreadable usage.`);
      if (drift > 0)
        notes.push(`${drift} runs used an unrecognised token layout and were skipped.`);
      if (truncated) notes.push("Some Cursor databases were left out to bound the scan.");
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
