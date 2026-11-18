import path from "node:path";

import {
  ImportTuning,
  type HistoryReader,
  type HistoryReaderContext,
  type HistoryRecord,
  type HistorySourceReport,
} from "../history-reader.ts";
import {
  isMissingError,
  openReadOnlyDatabase,
  parseTimestamp,
  tokenCount,
  type OpenDatabase,
  type ReadOnlyDb,
} from "./cursor.ts";

export interface OpenCodeReaderOptions {
  openDatabase?: OpenDatabase;
}

const DB_NAME = /^opencode(-[A-Za-z0-9_.-]+)?\.db$/;
const MESSAGE_TABLES = ["message", "session_message"] as const;

function dataDirectories(ctx: HistoryReaderContext): string[] {
  const explicit = ctx.env["OPENCODE_DATA_DIR"];
  if (explicit) {
    return explicit
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => path.isAbsolute(entry));
  }
  const xdg = ctx.env["XDG_DATA_HOME"];
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(ctx.homeDir, ".local", "share");
  return [path.join(base, "opencode")];
}

function columnNames(db: ReadOnlyDb, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of db.all(`PRAGMA table_info(${table})`)) {
    if (typeof row["name"] === "string") names.add(row["name"]);
  }
  return names;
}

/** Only JSON keys and columns that carry usage are projected; `data` itself is never selected. */
function planQuery(table: (typeof MESSAGE_TABLES)[number], columns: ReadonlySet<string>) {
  for (const required of ["id", "session_id", "time_created", "data"]) {
    if (!columns.has(required)) return null;
  }
  const guards = [
    "(json_extract(data, '$.role') IS NULL OR json_extract(data, '$.role') = 'assistant')",
  ];
  if (table === "session_message" && columns.has("type")) {
    guards.push("type IN ('assistant', 'compaction')");
  }
  const at = "COALESCE(json_extract(data, '$.time.created'), time_created)";
  const sql = [
    "SELECT id, session_id,",
    `${at} AS at,`,
    "COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID'), json_extract(data, '$.model.id')) AS model,",
    "json_extract(data, '$.tokens.input') AS t_input,",
    "json_extract(data, '$.tokens.output') AS t_output,",
    "json_extract(data, '$.tokens.reasoning') AS t_reasoning,",
    "json_extract(data, '$.tokens.cache.read') AS t_cache_read,",
    "json_extract(data, '$.tokens.cache.write') AS t_cache_write,",
    "json_extract(data, '$.cost') AS cost",
    `FROM ${table}`,
    `WHERE ${guards.join(" AND ")} AND json_extract(data, '$.tokens') IS NOT NULL`,
    `AND ${at} >= ? AND ${at} < ?`,
  ].join(" ");
  return sql;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function scalarId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" ? String(value) : null;
}

export function createOpenCodeHistoryReader(options: OpenCodeReaderOptions = {}): HistoryReader {
  const openDatabase = options.openDatabase ?? openReadOnlyDatabase;
  return {
    origin: "opencode",
    async read(ctx: HistoryReaderContext) {
      const databases: string[] = [];
      let listed = false;
      let listFailed = false;
      for (const dir of dataDirectories(ctx)) {
        try {
          const names = await ctx.fs.readdir(dir);
          listed = true;
          for (const name of names) {
            if (DB_NAME.test(name)) databases.push(path.join(dir, name));
          }
        } catch (error) {
          if (!isMissingError(error)) listFailed = true;
        }
      }
      const truncated = databases.length > ImportTuning.filesPerScan;
      if (!listed || databases.length === 0) {
        return {
          records: [],
          report: {
            origin: "opencode",
            status: listFailed ? "failed" : "missing",
            files: 0,
            note: listFailed
              ? "OpenCode history could not be listed."
              : "No OpenCode history found.",
          } satisfies HistorySourceReport,
        };
      }

      const records: HistoryRecord[] = [];
      let opened = 0;
      let unreadable = 0;
      let skippedRows = 0;
      for (const dbPath of databases.slice(0, ImportTuning.filesPerScan)) {
        if (ctx.signal.aborted) break;
        let db: ReadOnlyDb;
        try {
          db = openDatabase(dbPath);
        } catch {
          unreadable += 1;
          continue;
        }
        try {
          const present = new Set(
            db
              .all("SELECT name FROM sqlite_master WHERE type = 'table'")
              .flatMap((row) => (typeof row["name"] === "string" ? [row["name"]] : [])),
          );
          let usable = false;
          let planFailed = false;
          for (const table of MESSAGE_TABLES) {
            if (!present.has(table)) continue;
            const sql = planQuery(table, columnNames(db, table));
            if (sql === null) {
              planFailed = true;
              unreadable += 1;
              continue;
            }
            usable = true;
            for (const row of db.all(sql, [ctx.sinceMs, ctx.untilMs])) {
              if (ctx.signal.aborted) break;
              const at = parseTimestamp(row["at"]);
              const session = scalarId(row["session_id"]);
              const id = scalarId(row["id"]);
              const input = tokenCount(row["t_input"]);
              const output = tokenCount(row["t_output"]);
              const reasoning = tokenCount(row["t_reasoning"]);
              const cacheRead = tokenCount(row["t_cache_read"]);
              const cacheWrite = tokenCount(row["t_cache_write"]);
              if (
                at === null ||
                session === null ||
                input === null ||
                output === null ||
                reasoning === null ||
                cacheRead === null ||
                cacheWrite === null
              ) {
                skippedRows += 1;
                continue;
              }
              if (at < ctx.sinceMs || at >= ctx.untilMs) continue;
              if (input + output + reasoning + cacheRead + cacheWrite === 0) continue;
              const model = text(row["model"]) ?? "unknown";
              const cost = row["cost"];
              const reportedCost =
                typeof cost === "number" && Number.isFinite(cost) && cost >= 0
                  ? cost > 0 || model.endsWith("-free")
                    ? cost
                    : undefined
                  : undefined;
              records.push({
                origin: "opencode",
                model,
                sessionKey: session,
                at,
                inputTokens: input,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                outputTokens: output,
                ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
                ...(reportedCost === undefined ? {} : { reportedCostUsd: reportedCost }),
                ...(id === null ? {} : { dedupeKey: `opencode:${id}` }),
              });
            }
          }
          if (usable) opened += 1;
          else if (!planFailed) unreadable += 1;
        } catch {
          unreadable += 1;
        } finally {
          try {
            db.close();
          } catch {
            // A failed close of a read-only handle changes nothing.
          }
        }
      }

      const notes: string[] = [];
      if (ctx.signal.aborted) notes.push("Scan was cancelled.");
      if (unreadable > 0)
        notes.push(`${unreadable} OpenCode tables or databases could not be read.`);
      if (skippedRows > 0) notes.push(`${skippedRows} messages had unreadable usage.`);
      if (truncated) notes.push("Some OpenCode databases were left out to bound the scan.");
      return {
        records,
        report: {
          origin: "opencode",
          status: notes.length > 0 ? "partial" : "ok",
          files: opened,
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        } satisfies HistorySourceReport,
      };
    },
  };
}

export const opencodeHistoryReader: HistoryReader = createOpenCodeHistoryReader();
