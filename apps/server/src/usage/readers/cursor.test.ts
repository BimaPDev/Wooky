import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { HistoryFs, HistoryReaderContext } from "../history-reader.ts";
import {
  createCursorHistoryReader,
  cursorHistoryReader,
  decodeCursorAccountCache,
  readCursorIdeDatabase,
  type ReadOnlyDb,
} from "./cursor.ts";

const HOME = "/home/tester";
const DB = `${HOME}/.cursor/projects/alpha/index.db`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const SECRET_PROMPT = "FAKE-PROMPT-please-refactor-the-billing-module";
const SECRET_KEY = "FAKE-CREDENTIAL-sk-live-000";

function fakeFs(
  files: Record<string, number>,
  extras: { bodies?: Record<string, string | Uint8Array>; sizes?: Record<string, number> } = {},
): HistoryFs {
  const dirs = new Map<string, Set<string>>();
  const add = (parent: string, child: string) => {
    const names = dirs.get(parent) ?? new Set<string>();
    names.add(child);
    dirs.set(parent, names);
  };
  for (const file of Object.keys(files)) {
    const parts = file.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      add("/" + parts.slice(0, i).join("/"), parts[i] ?? "");
    }
  }
  const missing = (): never => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  return {
    readFile: async (target) => {
      const body = extras.bodies?.[target];
      if (typeof body === "string") return new TextEncoder().encode(body);
      if (body !== undefined) return body;
      return new Uint8Array();
    },
    readdir: async (dir) => {
      const names = dirs.get(dir);
      return names ? [...names] : missing();
    },
    stat: async (target) => {
      const mtimeMs = files[target];
      if (mtimeMs !== undefined) {
        const body = extras.bodies?.[target];
        const fromBody =
          typeof body === "string" ? body.length : body !== undefined ? body.byteLength : 1;
        return {
          size: extras.sizes?.[target] ?? fromBody,
          mtimeMs,
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      if (dirs.has(target)) {
        return { size: 0, mtimeMs: NOW, isFile: () => false, isDirectory: () => true };
      }
      return missing();
    },
  };
}

function ctx(fs: HistoryFs, patch: Partial<HistoryReaderContext> = {}): HistoryReaderContext {
  return {
    homeDir: HOME,
    env: {},
    sinceMs: NOW - 7 * DAY,
    untilMs: NOW + DAY,
    signal: new AbortController().signal,
    fs,
    ...patch,
  };
}

interface Run {
  run_id: string;
  agent_id: string;
  model: string | null;
  started_at: string;
  usage: unknown;
}

function runsDb(runs: Run[], extra = true): { db: ReadOnlyDb; sql: string[] } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    `CREATE TABLE runs (run_id TEXT, agent_id TEXT, model TEXT, started_at TEXT, created_at TEXT, usage_json TEXT${
      extra ? ", result TEXT, model_params_json TEXT" : ""
    })`,
  );
  if (extra) raw.exec("CREATE TABLE credentials (token TEXT)");
  if (extra) raw.prepare("INSERT INTO credentials VALUES (?)").run(SECRET_KEY);
  for (const run of runs) {
    raw
      .prepare(
        "INSERT INTO runs (run_id, agent_id, model, started_at, usage_json" +
          (extra ? ", result, model_params_json" : "") +
          ") VALUES (?, ?, ?, ?, ?" +
          (extra ? ", ?, ?" : "") +
          ")",
      )
      .run(
        ...([
          run.run_id,
          run.agent_id,
          run.model,
          run.started_at,
          typeof run.usage === "string" ? run.usage : JSON.stringify(run.usage),
          ...(extra ? [SECRET_PROMPT, SECRET_KEY] : []),
        ] as string[]),
      );
  }
  const sql: string[] = [];
  return {
    sql,
    db: {
      all: (query, params = []) => {
        sql.push(query);
        return raw.prepare(query).all(...params) as Record<string, unknown>[];
      },
      close: () => raw.close(),
    },
  };
}

const usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 600,
  cacheWriteTokens: 100,
  totalTokens: 1200,
  reasoningTokens: 50,
};
const inWindow = new Date(NOW - DAY).toISOString();

describe("cursor history reader", () => {
  it("reads runs from per-project index databases", async () => {
    const { db } = runsDb([
      { run_id: "r1", agent_id: "a1", model: "gpt-5", started_at: inWindow, usage },
    ]);
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const result = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(result.report).toEqual({ origin: "cursor", status: "ok", files: 1 });
    expect(result.records).toEqual([
      {
        origin: "cursor",
        model: "gpt-5",
        sessionKey: "a1",
        at: NOW - DAY,
        inputTokens: 300,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
        dedupeKey: "cursor:r1",
      },
    ]);
  });

  it("exports a default reader that reports missing history", async () => {
    const result = await cursorHistoryReader.read(ctx(fakeFs({})));
    expect(result.report.status).toBe("missing");
  });

  it("treats inputTokens as cache-inclusive and clamps at zero", async () => {
    const { db } = runsDb([
      {
        run_id: "r1",
        agent_id: "a1",
        model: null,
        started_at: inWindow,
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 80,
          cacheWriteTokens: 0,
          totalTokens: 55,
        },
      },
    ]);
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(records[0]).toMatchObject({ model: "default", inputTokens: 0, cacheReadTokens: 80 });
    expect(records[0]).not.toHaveProperty("reasoningTokens");
  });

  it("returns missing when there is no Cursor projects directory", async () => {
    const reader = createCursorHistoryReader({
      openDatabase: () => {
        throw new Error("should not open");
      },
    });
    const result = await reader.read(ctx(fakeFs({})));
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("missing");
  });

  it("skips malformed rows and flags drift as partial", async () => {
    const { db } = runsDb([
      { run_id: "bad", agent_id: "a1", model: "m", started_at: inWindow, usage: "{not json" },
      {
        run_id: "neg",
        agent_id: "a1",
        model: "m",
        started_at: inWindow,
        usage: { inputTokens: -1, outputTokens: 1 },
      },
      {
        run_id: "drift",
        agent_id: "a1",
        model: "m",
        started_at: inWindow,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
          totalTokens: 19,
        },
      },
      { run_id: "good", agent_id: "a1", model: "m", started_at: inWindow, usage },
    ]);
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const result = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(result.records.map((r) => r.dedupeKey)).toEqual(["cursor:good"]);
    expect(result.report.status).toBe("partial");
    expect(result.report.note).toContain("2 runs had unreadable usage");
    expect(result.report.note).toContain("1 runs used an unrecognised token layout");
  });

  it("reports partial when a database fails to open or lacks columns", async () => {
    const other = `${HOME}/.cursor/projects/beta/index.db`;
    const lacking = new DatabaseSync(":memory:");
    lacking.exec("CREATE TABLE runs (model TEXT)");
    const { db } = runsDb([
      { run_id: "r1", agent_id: "a1", model: "m", started_at: inWindow, usage },
    ]);
    const third = `${HOME}/.cursor/projects/gamma/index.db`;
    const reader = createCursorHistoryReader({
      openDatabase: (target) => {
        if (target === DB) return db;
        if (target === other) throw new Error("locked");
        return {
          all: (q) => lacking.prepare(q).all() as Record<string, unknown>[],
          close: () => lacking.close(),
        };
      },
    });
    const result = await reader.read(
      ctx(fakeFs({ [DB]: NOW, [other]: NOW - 1, [third]: NOW - 2 })),
    );
    expect(result.records).toHaveLength(1);
    expect(result.report.status).toBe("partial");
    expect(result.report.note).toContain("2 Cursor databases could not be read");
  });

  it("applies the window as [sinceMs, untilMs)", async () => {
    const at = (offset: number) => new Date(NOW + offset).toISOString();
    const { db } = runsDb(
      [-8 * DAY, -7 * DAY, DAY - 1, DAY].map((offset, index) => ({
        run_id: `r${index}`,
        agent_id: "a1",
        model: "m",
        started_at: at(offset),
        usage,
      })),
    );
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(records.map((r) => r.dedupeKey)).toEqual(["cursor:r1", "cursor:r2"]);
  });

  it("skips databases older than the mtime slack without opening them", async () => {
    const reader = createCursorHistoryReader({
      openDatabase: () => {
        throw new Error("should not open");
      },
    });
    const result = await reader.read(ctx(fakeFs({ [DB]: NOW - 30 * DAY })));
    expect(result.report).toEqual({ origin: "cursor", status: "ok", files: 0 });
  });

  it("stops and reports partial when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = createCursorHistoryReader({
      openDatabase: () => {
        throw new Error("should not open");
      },
    });
    const result = await reader.read(ctx(fakeFs({ [DB]: NOW }), { signal: controller.signal }));
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("partial");
  });

  it("never selects, returns or reports prompt or credential columns", async () => {
    const { db, sql } = runsDb([
      { run_id: "r1", agent_id: "a1", model: "gpt-5", started_at: inWindow, usage },
    ]);
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const result = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_PROMPT);
    expect(serialized).not.toContain(SECRET_KEY);
    const queries = sql.join("\n");
    expect(queries).not.toMatch(/\*|result|model_params_json|credentials|token\b/i);
    expect(queries).toContain("usage_json");
  });

  it("reads billed account cache records and keeps the reported cost", async () => {
    const cachePath = `${HOME}/.t3/userdata/${"usage-cursor-account-cache-v2.json"}`;
    const at = NOW - DAY;
    const body = JSON.stringify({
      version: 2,
      strings: ["composer-2.5", "sess-billed"],
      accounts: {
        acct: {
          records: [[at, 0, 1, 100, 200, 10, 20, 1.5, "cursor:evt-1"]],
        },
      },
    });
    const reader = createCursorHistoryReader({
      openDatabase: () => {
        throw new Error("should not open local databases when billed records exist");
      },
    });
    const result = await reader.read(
      ctx(fakeFs({ [cachePath]: NOW, [DB]: NOW }, { bodies: { [cachePath]: body } })),
    );
    expect(result.report.status).toBe("ok");
    expect(result.records).toEqual([
      {
        origin: "cursor",
        model: "composer-2.5",
        sessionKey: "sess-billed",
        at,
        inputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 10,
        outputTokens: 20,
        reportedCostUsd: 1.5,
        dedupeKey: "cursor:evt-1",
      },
    ]);
  });

  it("skips project runs that duplicate a billed session", async () => {
    const cachePath = `${HOME}/.t3/userdata/${"usage-cursor-account-cache-v2.json"}`;
    const at = NOW - DAY;
    const body = JSON.stringify({
      version: 2,
      strings: ["gpt-5", "a1"],
      accounts: {
        acct: {
          records: [[at, 0, 1, 300, 600, 100, 200, 0.4]],
        },
      },
    });
    const { db } = runsDb([
      { run_id: "r1", agent_id: "a1", model: "gpt-5", started_at: inWindow, usage },
    ]);
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(
      ctx(fakeFs({ [cachePath]: NOW, [DB]: NOW }, { bodies: { [cachePath]: body } })),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.reportedCostUsd).toBe(0.4);
    expect(records[0]?.sessionKey).toBe("a1");
  });

  it("reads composer bubbles from a small IDE database", async () => {
    const ide = `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
    raw.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "bubbleId:composer-1:bubble-1",
      JSON.stringify({
        tokenCount: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 },
        createdAt: NOW - DAY,
        modelInfo: { modelName: "composer-2.5" },
        text: "FAKE-PROMPT-please-ignore",
      }),
    );
    raw.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
      "bubbleId:composer-1:empty",
      JSON.stringify({
        tokenCount: { inputTokens: 0, outputTokens: 0 },
        createdAt: NOW - DAY,
        modelInfo: { modelName: "composer-2.5" },
      }),
    );
    const sql: string[] = [];
    const db: ReadOnlyDb = {
      all: (query, params = []) => {
        sql.push(query);
        return raw.prepare(query).all(...(params ?? [])) as Record<string, unknown>[];
      },
      close: () => raw.close(),
    };
    const ideRows = readCursorIdeDatabase(db, NOW - 7 * DAY, NOW + DAY);
    expect(ideRows.records).toEqual([
      {
        origin: "cursor",
        model: "composer-2.5",
        sessionKey: "composer-1",
        at: NOW - DAY,
        inputTokens: 12,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
        outputTokens: 3,
        dedupeKey: `cursor:${Math.round((NOW - DAY) / 1000)}:composer-2.5:12:4:1:3`,
      },
    ]);
    const reader = createCursorHistoryReader({ openDatabase: () => db });
    const result = await reader.read(ctx(fakeFs({ [ide]: NOW })));
    expect(result.records).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("FAKE-PROMPT-please-ignore");
    expect(sql.join("\n")).not.toMatch(/\*|text|prompt/i);
  });

  it("does not open an oversized IDE database", async () => {
    const ide = `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
    const reader = createCursorHistoryReader({
      openDatabase: () => {
        throw new Error("should not open a huge IDE database");
      },
    });
    const result = await reader.read(
      ctx(fakeFs({ [ide]: NOW }, { sizes: { [ide]: 65 * 1024 * 1024 } })),
    );
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("ok");
  });
});

describe("decodeCursorAccountCache", () => {
  it("resolves interned strings and drops zero-token rows without cost", () => {
    const at = NOW - DAY;
    const records = decodeCursorAccountCache(
      {
        version: 2,
        strings: ["default", "sess-z"],
        accounts: {
          a: {
            records: [
              [at, 0, 1, 0, 0, 0, 0, 0],
              [at, 0, 1, 1, 0, 0, 0, 0.2, "k"],
            ],
          },
        },
      },
      NOW - 7 * DAY,
      NOW + DAY,
    );
    expect(records).toEqual([
      {
        origin: "cursor",
        model: "default",
        sessionKey: "sess-z",
        at,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reportedCostUsd: 0.2,
        dedupeKey: "k",
      },
    ]);
  });
});
