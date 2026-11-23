import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ServiceError } from "../errors.ts";
import type { BrainLog } from "./paths.ts";
import { assertNoSecret } from "./safety.ts";

/**
 * Live state of a fleet run: who holds which files, what one worker hands the next, what a worker
 * found. It is temporary and advisory, so it lives in `<home>/brain-runs.sqlite` and never in the
 * repo. A run is identified by its coordinator's thread id (see `fleetRunId`).
 *
 * This file is its own database, not the search index (a cache that is deleted and rebuilt) and
 * not the event store (authoritative, replayed and synced). Losing it costs nothing but live hints.
 */

export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_LIVE_CLAIMS_PER_RUN = 100;
export const MAX_TEXT_CHARS = 2048;
export const MAX_TARGET_CHARS = 200;
/** Handoffs and findings per run. At the cap the oldest is dropped. */
export const MAX_NOTES_PER_RUN = 100;
/** Handoffs and findings are dropped this long after they were written. */
export const NOTE_RETENTION_MS = 24 * 60 * 60 * 1000;

const Id = z.string().min(1).max(128);
const Text = z.string().max(MAX_TEXT_CHARS);

export const ClaimInput = z.object({
  runId: Id,
  projectId: Id,
  threadId: Id,
  agent: z.string().min(1).max(64),
  /** A path, a glob such as `src/**`, or a label such as `topic:auth`. */
  target: z.string().min(1).max(MAX_TARGET_CHARS),
  note: Text.default(""),
});
export type ClaimInput = z.input<typeof ClaimInput>;

export const HandoffInput = z.object({
  runId: Id,
  fromThreadId: Id,
  toThreadId: Id.optional(),
  summary: z.string().min(1).max(MAX_TEXT_CHARS),
});
export type HandoffInput = z.input<typeof HandoffInput>;

export const FindingsInput = z.object({
  runId: Id,
  threadId: Id,
  text: z.string().min(1).max(MAX_TEXT_CHARS),
});
export type FindingsInput = z.input<typeof FindingsInput>;

export interface Claim {
  id: string;
  runId: string;
  projectId: string;
  threadId: string;
  agent: string;
  target: string;
  note: string;
  createdAt: string;
  expiresAt: string;
}

export interface Handoff {
  id: string;
  runId: string;
  fromThreadId: string;
  toThreadId: string | null;
  summary: string;
  createdAt: string;
}

export interface Finding {
  id: string;
  runId: string;
  threadId: string;
  text: string;
  createdAt: string;
}

/** `claimed`: this thread now holds the target. `held`: another thread does, and is returned. */
export type ClaimResult = { status: "claimed"; claim: Claim } | { status: "held"; holder: Claim };

export interface RunSnapshot {
  claims: Claim[];
  handoffs: Handoff[];
  findings: Finding[];
}

/**
 * What `wooky mcp`'s `brain_claim`, `brain_release` and `brain_handoff` tools call. The caller's
 * thread, run and project come from its agent token, never from tool arguments.
 */
export interface RunCoordination {
  claim(input: ClaimInput): ClaimResult;
  /** With `threadId`, only that thread's own claim is released; anyone else's is left alone. */
  release(claimId: string, threadId?: string): boolean;
  list(runId: string): RunSnapshot;
  handoff(input: HandoffInput): Handoff;
  findings(input: FindingsInput): Finding;
  /** Releases every claim a thread holds. Handoffs and findings stay for the run. */
  releaseThread(threadId: string): number;
  close(): void;
}

export interface RunStoreOptions {
  home: string;
  now?: () => number;
  ttlMs?: number;
  log?: BrainLog;
}

/** The run a thread belongs to: a coordinator's own id, a worker's parent. Solo threads have none. */
export function fleetRunId(thread: {
  id: string;
  role?: string | undefined;
  parentThreadId?: string | undefined;
}): string | null {
  if (thread.role === "coordinator") return thread.id;
  if (thread.role === "worker" && thread.parentThreadId !== undefined) return thread.parentThreadId;
  return null;
}

const WILDCARD = /[*?[\]{}]/;

function normalizeTarget(target: string): string {
  return target
    .normalize("NFKC")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function segmentGlob(pattern: string, literal: string): boolean {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(literal);
}

function segmentsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aWild = WILDCARD.test(a);
  const bWild = WILDCARD.test(b);
  if (aWild && bWild) return true;
  if (aWild) return segmentGlob(a, b);
  if (bWild) return segmentGlob(b, a);
  return false;
}

/**
 * Two targets overlap when one names the other or something inside it: the same path, a folder
 * and a file below it, or globs that can match a common path. Wildcards on both sides count as
 * overlap, since telling otherwise is not worth being wrong about. A claim is only advice.
 */
export function targetsOverlap(first: string, second: string): boolean {
  const a = normalizeTarget(first).split("/");
  const b = normalizeTarget(second).split("/");
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index] ?? "";
    const right = b[index] ?? "";
    if (left === "**" || right === "**") return true;
    if (!segmentsOverlap(left, right)) return false;
  }
  return true;
}

const SCHEMA_VERSION = 1;

interface ClaimRow {
  id: string;
  run_id: string;
  project_id: string;
  thread_id: string;
  agent: string;
  target: string;
  note: string;
  created_at: number;
  expires_at: number;
}

interface HandoffRow {
  id: string;
  run_id: string;
  from_thread_id: string;
  to_thread_id: string | null;
  summary: string;
  created_at: number;
}

interface FindingRow {
  id: string;
  run_id: string;
  thread_id: string;
  text: string;
  created_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

const toClaim = (row: ClaimRow): Claim => ({
  id: row.id,
  runId: row.run_id,
  projectId: row.project_id,
  threadId: row.thread_id,
  agent: row.agent,
  target: row.target,
  note: row.note,
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
});

function parse<T>(schema: z.ZodType<T, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".") || "input";
  throw new ServiceError("bad_request", `Invalid ${field}: ${issue?.message ?? "bad value"}`);
}

/** Control characters other than newline, carriage return and tab have no place in a note. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;

function checkText(label: string, value: string, multiline = true): void {
  if (CONTROL.test(value.replace(/[\n\r\t]/g, ""))) {
    throw new ServiceError("bad_request", `The ${label} contains control characters.`);
  }
  if (!multiline && /[\n\r\t]/.test(value)) {
    throw new ServiceError("bad_request", `The ${label} must be a single line.`);
  }
  assertNoSecret(value, label);
}

export function createRunStore(options: RunStoreOptions): RunCoordination {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? CLAIM_TTL_MS;
  const log = options.log ?? ((message: string) => console.error(message));
  const file = join(options.home, "brain-runs.sqlite");
  let db: DatabaseSync | null = null;

  function open(): DatabaseSync {
    if (db !== null) return db;
    mkdirSync(dirname(file), { recursive: true });
    const opened = new DatabaseSync(file);
    try {
      opened.exec("PRAGMA busy_timeout = 2000");
      opened.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      const version = (opened.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
      if (version !== SCHEMA_VERSION) {
        // Live hints only: an old layout is dropped rather than migrated.
        opened.exec(`
          DROP TABLE IF EXISTS claims; DROP TABLE IF EXISTS handoffs; DROP TABLE IF EXISTS findings;
          CREATE TABLE claims (
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
            thread_id TEXT NOT NULL, agent TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL,
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
          );
          CREATE INDEX claims_run ON claims (run_id);
          CREATE INDEX claims_thread ON claims (thread_id);
          CREATE TABLE handoffs (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT NOT NULL,
            from_thread_id TEXT NOT NULL, to_thread_id TEXT, summary TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX handoffs_run ON handoffs (run_id);
          CREATE TABLE findings (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, run_id TEXT NOT NULL,
            thread_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE INDEX findings_run ON findings (run_id);
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      }
    } catch (error) {
      opened.close();
      throw error;
    }
    db = opened;
    return opened;
  }

  /** Reads on a database nobody has written yet must not create it. */
  const openIfPresent = (): DatabaseSync | null =>
    db !== null || existsSync(file) ? open() : null;

  function purge(database: DatabaseSync, at: number): void {
    database.prepare("DELETE FROM claims WHERE expires_at <= ?").run(at);
    database.prepare("DELETE FROM handoffs WHERE created_at <= ?").run(at - NOTE_RETENTION_MS);
    database.prepare("DELETE FROM findings WHERE created_at <= ?").run(at - NOTE_RETENTION_MS);
  }

  function transaction<T>(database: DatabaseSync, run: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The first failure is the one to report.
      }
      throw error;
    }
  }

  function trim(database: DatabaseSync, table: "handoffs" | "findings", runId: string): void {
    database
      .prepare(
        `DELETE FROM ${table} WHERE run_id = ? AND seq NOT IN
           (SELECT seq FROM ${table} WHERE run_id = ? ORDER BY seq DESC LIMIT ?)`,
      )
      .run(runId, runId, MAX_NOTES_PER_RUN);
  }

  function guard<T>(operation: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      log(
        `brain: run state ${operation} failed (${typeof code === "string" ? code : error instanceof Error ? error.name : "unknown error"})`,
      );
      throw new ServiceError("internal", `Run state ${operation} failed.`);
    }
  }

  return {
    claim(raw) {
      const input = parse(ClaimInput, raw);
      checkText("target", input.target, false);
      checkText("note", input.note);
      checkText("agent", input.agent, false);
      return guard("claim", () => {
        const database = open();
        return transaction(database, () => {
          const at = now();
          purge(database, at);
          const live = (
            database
              .prepare("SELECT * FROM claims WHERE run_id = ? ORDER BY created_at, id")
              .all(input.runId) as unknown as ClaimRow[]
          ).map(toClaim);
          const own = live.find(
            (claim) => claim.threadId === input.threadId && claim.target === input.target,
          );
          if (own !== undefined) {
            database
              .prepare("UPDATE claims SET note = ?, expires_at = ? WHERE id = ?")
              .run(input.note, at + ttl, own.id);
            return {
              status: "claimed" as const,
              claim: { ...own, note: input.note, expiresAt: iso(at + ttl) },
            };
          }
          const holder = live.find(
            (claim) =>
              claim.threadId !== input.threadId && targetsOverlap(claim.target, input.target),
          );
          if (holder !== undefined) return { status: "held" as const, holder };
          if (live.length >= MAX_LIVE_CLAIMS_PER_RUN) {
            throw new ServiceError(
              "bad_request",
              `This run already holds ${MAX_LIVE_CLAIMS_PER_RUN} claims. Release some first.`,
            );
          }
          const claim: Claim = {
            id: randomUUID(),
            runId: input.runId,
            projectId: input.projectId,
            threadId: input.threadId,
            agent: input.agent,
            target: input.target,
            note: input.note,
            createdAt: iso(at),
            expiresAt: iso(at + ttl),
          };
          database
            .prepare(
              `INSERT INTO claims (id, run_id, project_id, thread_id, agent, target, note, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              claim.id,
              claim.runId,
              claim.projectId,
              claim.threadId,
              claim.agent,
              claim.target,
              claim.note,
              at,
              at + ttl,
            );
          return { status: "claimed" as const, claim };
        });
      });
    },

    release(claimId, threadId) {
      return guard("release", () => {
        const database = openIfPresent();
        if (database === null) return false;
        const result =
          threadId === undefined
            ? database.prepare("DELETE FROM claims WHERE id = ?").run(claimId)
            : database
                .prepare("DELETE FROM claims WHERE id = ? AND thread_id = ?")
                .run(claimId, threadId);
        return Number(result.changes) > 0;
      });
    },

    releaseThread(threadId) {
      return guard("release", () => {
        const database = openIfPresent();
        if (database === null) return 0;
        return Number(
          database.prepare("DELETE FROM claims WHERE thread_id = ?").run(threadId).changes,
        );
      });
    },

    list(runId) {
      return guard("list", () => {
        const database = openIfPresent();
        if (database === null) return { claims: [], handoffs: [], findings: [] };
        const at = now();
        const claims = (
          database
            .prepare(
              "SELECT * FROM claims WHERE run_id = ? AND expires_at > ? ORDER BY created_at, id",
            )
            .all(runId, at) as unknown as ClaimRow[]
        ).map(toClaim);
        const since = at - NOTE_RETENTION_MS;
        const handoffs = (
          database
            .prepare("SELECT * FROM handoffs WHERE run_id = ? AND created_at > ? ORDER BY seq")
            .all(runId, since) as unknown as HandoffRow[]
        ).map((row): Handoff => ({
          id: row.id,
          runId: row.run_id,
          fromThreadId: row.from_thread_id,
          toThreadId: row.to_thread_id,
          summary: row.summary,
          createdAt: iso(row.created_at),
        }));
        const findings = (
          database
            .prepare("SELECT * FROM findings WHERE run_id = ? AND created_at > ? ORDER BY seq")
            .all(runId, since) as unknown as FindingRow[]
        ).map((row): Finding => ({
          id: row.id,
          runId: row.run_id,
          threadId: row.thread_id,
          text: row.text,
          createdAt: iso(row.created_at),
        }));
        return { claims, handoffs, findings };
      });
    },

    handoff(raw) {
      const input = parse(HandoffInput, raw);
      checkText("summary", input.summary);
      return guard("handoff", () => {
        const database = open();
        return transaction(database, () => {
          const at = now();
          purge(database, at);
          const handoff: Handoff = {
            id: randomUUID(),
            runId: input.runId,
            fromThreadId: input.fromThreadId,
            toThreadId: input.toThreadId ?? null,
            summary: input.summary,
            createdAt: iso(at),
          };
          database
            .prepare(
              `INSERT INTO handoffs (id, run_id, from_thread_id, to_thread_id, summary, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              handoff.id,
              handoff.runId,
              handoff.fromThreadId,
              handoff.toThreadId,
              handoff.summary,
              at,
            );
          trim(database, "handoffs", input.runId);
          return handoff;
        });
      });
    },

    findings(raw) {
      const input = parse(FindingsInput, raw);
      checkText("text", input.text);
      return guard("findings", () => {
        const database = open();
        return transaction(database, () => {
          const at = now();
          purge(database, at);
          const finding: Finding = {
            id: randomUUID(),
            runId: input.runId,
            threadId: input.threadId,
            text: input.text,
            createdAt: iso(at),
          };
          database
            .prepare(
              "INSERT INTO findings (id, run_id, thread_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(finding.id, finding.runId, finding.threadId, finding.text, at);
          trim(database, "findings", input.runId);
          return finding;
        });
      });
    },

    close() {
      db?.close();
      db = null;
    },
  };
}
