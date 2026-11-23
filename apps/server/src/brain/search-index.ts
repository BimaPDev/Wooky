import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrainKind, BrainStatus } from "@wooky/contracts";
import type { BrainLog, ScannedFile } from "./paths.ts";

/**
 * Search cache at `<home>/brain/index.sqlite`. It holds nothing the Markdown files do not, so a
 * damaged or out-of-date index is deleted and rebuilt. FTS5 with BM25 when this SQLite has it,
 * otherwise a plain table searched with LIKE.
 */

const SCHEMA_VERSION = 1;
/** A file edited this close to when it was indexed may share its mtime with a later edit. */
const RACY_MS = 2000;
const MAX_TERMS = 16;

export interface IndexedDoc {
  summary: string;
  kind: BrainKind;
  tags: string[];
  status: BrainStatus;
  pinned: boolean;
  updatedAt: string;
  body: string;
}

export interface LoadedFile {
  raw: Buffer;
  doc: IndexedDoc;
}

export interface SyncReport {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface IndexHit {
  scopeKey: string;
  path: string;
  summary: string;
  kind: BrainKind;
  tags: string[];
  status: BrainStatus;
  updatedAt: string;
  score: number;
}

export interface IndexSearch {
  scopeKeys: readonly string[];
  /** A folder path, or a memory path. Empty means everything. */
  pathPrefix?: string;
  limit: number;
  includeArchived?: boolean;
}

export interface BrainIndexOptions {
  /** Pretend FTS5 is missing, to exercise the fallback. */
  noFts5?: boolean;
  now?: () => number;
  log?: BrainLog;
}

/** Plain lowercase words. Anything FTS5 would read as syntax is dropped here, not escaped. */
export function searchTerms(query: string): string[] {
  const words =
    query
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.map((word) => word.slice(0, 64)))].slice(0, MAX_TERMS);
}

interface FileRow {
  id: number;
  path: string;
  mtime_ms: number;
  size: number;
  hash: string;
  indexed_at: number;
}

interface HitRow {
  scope_key: string;
  path: string;
  summary: string;
  kind: string;
  tags: string;
  status: string;
  updated_at: string;
  rank: number;
  body?: string;
  path_text?: string;
}

const sha256 = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");

export class BrainIndex {
  readonly fts5: boolean;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, fts5: boolean, now: () => number) {
    this.db = db;
    this.fts5 = fts5;
    this.now = now;
  }

  /** Brings one scope's rows in line with the files found on disk. */
  sync(
    scopeKey: string,
    scanned: readonly ScannedFile[],
    load: (path: string) => LoadedFile | null,
  ): SyncReport {
    const report: SyncReport = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const rows = new Map(
      (
        this.db
          .prepare(
            "SELECT id, path, mtime_ms, size, hash, indexed_at FROM files WHERE scope_key = ?",
          )
          .all(scopeKey) as unknown as FileRow[]
      ).map((row) => [row.path, row]),
    );
    const indexedAt = this.now();
    this.db.exec("BEGIN");
    try {
      for (const file of scanned) {
        const row = rows.get(file.path);
        rows.delete(file.path);
        if (
          row !== undefined &&
          row.size === file.size &&
          row.mtime_ms === file.mtimeMs &&
          file.mtimeMs < row.indexed_at - RACY_MS
        ) {
          report.unchanged += 1;
          continue;
        }
        const loaded = load(file.path);
        if (loaded === null) {
          if (row !== undefined) this.deleteRow(row.id);
          if (row !== undefined) report.removed += 1;
          continue;
        }
        const hash = sha256(loaded.raw);
        if (row !== undefined && row.hash === hash) {
          this.db
            .prepare("UPDATE files SET mtime_ms = ?, size = ?, indexed_at = ? WHERE id = ?")
            .run(file.mtimeMs, file.size, indexedAt, row.id);
          report.unchanged += 1;
          continue;
        }
        this.store(scopeKey, file, hash, loaded.doc, row?.id, indexedAt);
        if (row === undefined) report.added += 1;
        else report.updated += 1;
      }
      for (const row of rows.values()) {
        this.deleteRow(row.id);
        report.removed += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return report;
  }

  private deleteRow(id: number): void {
    this.db.prepare("DELETE FROM docs WHERE rowid = ?").run(id);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(id);
  }

  private store(
    scopeKey: string,
    file: ScannedFile,
    hash: string,
    doc: IndexedDoc,
    existingId: number | undefined,
    indexedAt: number,
  ): void {
    let id = existingId;
    if (id === undefined) {
      const result = this.db
        .prepare(
          `INSERT INTO files (scope_key, path, mtime_ms, size, hash, indexed_at, summary, kind, tags, status, pinned, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scopeKey,
          file.path,
          file.mtimeMs,
          file.size,
          hash,
          indexedAt,
          doc.summary,
          doc.kind,
          JSON.stringify(doc.tags),
          doc.status,
          doc.pinned ? 1 : 0,
          doc.updatedAt,
        );
      id = Number(result.lastInsertRowid);
    } else {
      this.db
        .prepare(
          `UPDATE files SET mtime_ms = ?, size = ?, hash = ?, indexed_at = ?, summary = ?, kind = ?,
             tags = ?, status = ?, pinned = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          file.mtimeMs,
          file.size,
          hash,
          indexedAt,
          doc.summary,
          doc.kind,
          JSON.stringify(doc.tags),
          doc.status,
          doc.pinned ? 1 : 0,
          doc.updatedAt,
          id,
        );
      this.db.prepare("DELETE FROM docs WHERE rowid = ?").run(id);
    }
    this.db
      .prepare("INSERT INTO docs (rowid, summary, tags, body, path_text) VALUES (?, ?, ?, ?, ?)")
      .run(id, doc.summary, doc.tags.join(" "), doc.body, file.path.replace(/\.md$/, ""));
  }

  search(query: string, options: IndexSearch): IndexHit[] {
    const terms = searchTerms(query);
    if (terms.length === 0 || options.scopeKeys.length === 0) return [];
    const filters: string[] = [`f.scope_key IN (${options.scopeKeys.map(() => "?").join(", ")})`];
    const params: (string | number)[] = [...options.scopeKeys];
    if (options.includeArchived !== true) filters.push("f.status != 'archived'");
    const prefix = options.pathPrefix ?? "";
    if (prefix !== "") {
      filters.push("(f.path = ? OR substr(f.path, 1, ?) = ?)");
      params.push(prefix, prefix.length + 1, `${prefix}/`);
    }
    const where = filters.join(" AND ");
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    try {
      return this.fts5
        ? this.searchFts(terms, where, params, limit)
        : this.searchPlain(terms, where, params, limit);
    } catch {
      // Terms are plain words, so this is a damaged index, not a bad query.
      return [];
    }
  }

  private searchFts(terms: string[], where: string, params: (string | number)[], limit: number) {
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT f.scope_key, f.path, f.summary, f.kind, f.tags, f.status, f.updated_at,
                bm25(docs, 6.0, 3.0, 1.0, 2.0) AS rank
         FROM docs JOIN files f ON f.id = docs.rowid
         WHERE docs MATCH ? AND ${where}
         ORDER BY rank, f.path LIMIT ?`,
      )
      .all(match, ...params, limit) as unknown as HitRow[];
    return rows.map(toHit);
  }

  private searchPlain(terms: string[], where: string, params: (string | number)[], limit: number) {
    const rows = this.db
      .prepare(
        `SELECT f.scope_key, f.path, f.summary, f.kind, f.tags, f.status, f.updated_at, 0 AS rank,
                lower(docs.body) AS body, lower(docs.tags) AS tag_text, lower(docs.path_text) AS path_text,
                lower(docs.summary) AS summary_text
         FROM docs JOIN files f ON f.id = docs.rowid WHERE ${where}`,
      )
      .all(...params) as unknown as (HitRow & { tag_text: string; summary_text: string })[];
    const scored = rows
      .map((row) => {
        let score = 0;
        for (const term of terms) {
          if (row.summary_text.includes(term)) score += 6;
          if (row.tag_text.includes(term)) score += 3;
          if (row.path_text?.includes(term)) score += 2;
          if (row.body?.includes(term)) score += 1;
        }
        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || (a.row.path < b.row.path ? -1 : 1))
      .slice(0, limit);
    return scored.map(({ row, score }) => ({ ...toHit(row), score }));
  }

  close(): void {
    this.db.close();
  }
}

function toHit(row: HitRow): IndexHit {
  return {
    scopeKey: row.scope_key,
    path: row.path,
    summary: row.summary,
    kind: row.kind as BrainKind,
    tags: JSON.parse(row.tags) as string[],
    status: row.status as BrainStatus,
    updatedAt: row.updated_at,
    score: -row.rank,
  };
}

function hasFts5(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)");
    db.exec("DROP TABLE temp.fts5_probe");
    return true;
  } catch {
    return false;
  }
}

function prepare(db: DatabaseSync, fts5: boolean): void {
  const version = SCHEMA_VERSION * 10 + (fts5 ? 1 : 0);
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (current !== version) {
    db.exec("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS files;");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      indexed_at REAL NOT NULL,
      summary TEXT NOT NULL,
      kind TEXT NOT NULL,
      tags TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (scope_key, path)
    );
  `);
  db.exec(
    fts5
      ? "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(summary, tags, body, path_text, tokenize = 'porter unicode61')"
      : "CREATE TABLE IF NOT EXISTS docs (rowid INTEGER PRIMARY KEY, summary TEXT, tags TEXT, body TEXT, path_text TEXT)",
  );
  db.exec(`PRAGMA user_version = ${version}`);
}

function openOnce(file: string, options: BrainIndexOptions): BrainIndex {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const fts5 = options.noFts5 !== true && hasFts5(db);
    prepare(db, fts5);
    return new BrainIndex(db, fts5, options.now ?? Date.now);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Opens the index, deleting and recreating it once if it cannot be read. */
export function openBrainIndex(file: string, options: BrainIndexOptions = {}): BrainIndex {
  mkdirSync(dirname(file), { recursive: true });
  try {
    return openOnce(file, options);
  } catch (error) {
    options.log?.(`brain: rebuilding the search index (${(error as Error).message})`);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
    return openOnce(file, options);
  }
}
