import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ImportTuning, type HistoryFs, type HistoryReaderContext } from "../history-reader.ts";
import type { ReadOnlyDb } from "./cursor.ts";
import { createOpenCodeHistoryReader, opencodeHistoryReader } from "./opencode.ts";

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/opencode`;
const DB = `${DATA}/opencode.db`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const SECRET_PROMPT = "FAKE-PROMPT-summarise-the-private-roadmap";
const SECRET_PATH = "/fake/private/project/path";
const SECRET_KEY = "FAKE-CREDENTIAL-oc-key-000";
const SECRET_SYSTEM = "FAKE-SYSTEM-you-are-a-leak-bot";
const SECRET_SUMMARY = "FAKE-SUMMARY-internal-quarter-plans";

function fakeFs(dirs: Record<string, string[]>): HistoryFs {
  return {
    readFile: async () => new Uint8Array(),
    stat: async () => ({ size: 1, mtimeMs: NOW, isFile: () => true, isDirectory: () => false }),
    readdir: async (dir) => {
      const names = dirs[dir];
      if (!names) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return names;
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

interface Message {
  id: string;
  sessionId: string;
  at: number;
  data: Record<string, unknown>;
  type?: string;
}

function assistant(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    modelID: "claude-sonnet",
    providerID: "anthropic",
    cost: 0.25,
    tokens: { input: 100, output: 40, reasoning: 7, cache: { read: 300, write: 20 } },
    path: { cwd: SECRET_PATH },
    content: SECRET_PROMPT,
    system: SECRET_SYSTEM,
    summary: SECRET_SUMMARY,
    ...extra,
  };
}

function openCodeDb(layout: "message" | "session_message", messages: Message[]) {
  const raw = new DatabaseSync(":memory:");
  const typeColumn = layout === "session_message" ? ", type TEXT, seq INTEGER" : "";
  raw.exec(
    `CREATE TABLE ${layout} (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER${typeColumn}, data TEXT)`,
  );
  raw.exec("CREATE TABLE credential (secret TEXT)");
  raw.exec("CREATE TABLE session_input (prompt TEXT)");
  raw.prepare("INSERT INTO credential VALUES (?)").run(SECRET_KEY);
  raw.prepare("INSERT INTO session_input VALUES (?)").run(SECRET_PROMPT);
  for (const m of messages) {
    if (layout === "message") {
      raw
        .prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
        .run(m.id, m.sessionId, m.at, JSON.stringify(m.data));
    } else {
      raw
        .prepare(
          "INSERT INTO session_message (id, session_id, time_created, type, data) VALUES (?, ?, ?, ?, ?)",
        )
        .run(m.id, m.sessionId, m.at, m.type ?? "assistant", JSON.stringify(m.data));
    }
  }
  const sql: string[] = [];
  const db: ReadOnlyDb = {
    all: (query, params = []) => {
      sql.push(query);
      return raw.prepare(query).all(...params) as Record<string, unknown>[];
    },
    close: () => raw.close(),
  };
  return { db, sql };
}

const files = fakeFs({ [DATA]: ["opencode.db", "opencode.db-wal", "notes.txt"] });
const at = NOW - DAY;

describe("opencode history reader", () => {
  it("maps message token fields from the message table", async () => {
    const { db } = openCodeDb("message", [
      { id: "m1", sessionId: "s1", at, data: assistant() },
      { id: "m2", sessionId: "s1", at: at + 1, data: { role: "user", content: SECRET_PROMPT } },
    ]);
    const opened: string[] = [];
    const reader = createOpenCodeHistoryReader({
      openDatabase: (target) => (opened.push(target), db),
    });
    const result = await reader.read(ctx(files));
    expect(opened).toEqual([DB]);
    expect(result.report).toEqual({ origin: "opencode", status: "ok", files: 1 });
    expect(result.records).toEqual([
      {
        origin: "opencode",
        model: "claude-sonnet",
        sessionKey: "s1",
        at,
        inputTokens: 100,
        cacheReadTokens: 300,
        cacheWriteTokens: 20,
        outputTokens: 40,
        reasoningTokens: 7,
        reportedCostUsd: 0.25,
        dedupeKey: "opencode:m1",
      },
    ]);
  });

  it("reads session_message rows, keeps compaction, and prefers the JSON time", async () => {
    const jsonTime = at + 5000;
    const { db } = openCodeDb("session_message", [
      {
        id: "a",
        sessionId: "s2",
        at,
        data: assistant({ time: { created: jsonTime } }),
        type: "assistant",
      },
      { id: "c", sessionId: "s2", at, data: assistant({ role: undefined }), type: "compaction" },
      { id: "u", sessionId: "s2", at, data: assistant(), type: "user" },
    ]);
    const reader = createOpenCodeHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(files));
    expect(records.map((r) => [r.dedupeKey, r.at])).toEqual([
      ["opencode:a", jsonTime],
      ["opencode:c", at],
    ]);
  });

  it("only treats a zero cost as reported for free gateway models", async () => {
    const { db } = openCodeDb("message", [
      { id: "z", sessionId: "s", at, data: assistant({ cost: 0 }) },
      { id: "f", sessionId: "s", at, data: assistant({ cost: 0, modelID: "big-pickle-free" }) },
    ]);
    const reader = createOpenCodeHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(files));
    expect(records.find((r) => r.dedupeKey === "opencode:z")).not.toHaveProperty("reportedCostUsd");
    expect(records.find((r) => r.dedupeKey === "opencode:f")?.reportedCostUsd).toBe(0);
  });

  it("exports a default reader that reports missing history", async () => {
    const result = await opencodeHistoryReader.read(ctx(fakeFs({})));
    expect(result.report.status).toBe("missing");
  });

  it("honours XDG_DATA_HOME", async () => {
    const opened: string[] = [];
    const { db } = openCodeDb("message", []);
    const reader = createOpenCodeHistoryReader({
      openDatabase: (target) => (opened.push(target), db),
    });
    const fs = fakeFs({ "/xdg/opencode": ["opencode-work.db"] });
    const result = await reader.read(ctx(fs, { env: { XDG_DATA_HOME: "/xdg" } }));
    expect(opened).toEqual(["/xdg/opencode/opencode-work.db"]);
    expect(result.report.status).toBe("ok");
  });

  it("returns missing when there is no OpenCode data directory or database", async () => {
    const reader = createOpenCodeHistoryReader({
      openDatabase: () => {
        throw new Error("should not open");
      },
    });
    expect((await reader.read(ctx(fakeFs({})))).report.status).toBe("missing");
    expect((await reader.read(ctx(fakeFs({ [DATA]: ["other.txt"] })))).report.status).toBe(
      "missing",
    );
  });

  it("skips malformed rows and reports partial", async () => {
    const { db } = openCodeDb("message", [
      { id: "bad", sessionId: "s", at, data: assistant({ tokens: { input: "lots", output: 1 } }) },
      { id: "none", sessionId: "s", at, data: assistant({ tokens: undefined }) },
      { id: "good", sessionId: "s", at, data: assistant() },
    ]);
    const reader = createOpenCodeHistoryReader({ openDatabase: () => db });
    const result = await reader.read(ctx(files));
    expect(result.records.map((r) => r.dedupeKey)).toEqual(["opencode:good"]);
    expect(result.report.status).toBe("partial");
    expect(result.report.note).toContain("1 messages had unreadable usage");
  });

  it("reports partial when a database cannot be opened or has no usable table", async () => {
    const reader = createOpenCodeHistoryReader({
      openDatabase: () => {
        throw new Error("locked");
      },
    });
    const result = await reader.read(ctx(files));
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("partial");
  });

  it("applies the window as [sinceMs, untilMs)", async () => {
    const times = [NOW - 8 * DAY, NOW - 7 * DAY, NOW + DAY - 1, NOW + DAY];
    const { db } = openCodeDb(
      "message",
      times.map((t, i) => ({ id: `m${i}`, sessionId: "s", at: t, data: assistant() })),
    );
    const reader = createOpenCodeHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(files));
    expect(records.map((r) => r.dedupeKey)).toEqual(["opencode:m1", "opencode:m2"]);
  });

  it("stops without opening anything when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = createOpenCodeHistoryReader({
      openDatabase: () => {
        throw new Error("should not open");
      },
    });
    const result = await reader.read(ctx(files, { signal: controller.signal }));
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("partial");
  });

  it("caps databases per scan and reports partial", async () => {
    const names = Array.from(
      { length: ImportTuning.filesPerScan + 2 },
      (_, i) => `opencode-${i}.db`,
    );
    const reader = createOpenCodeHistoryReader({
      openDatabase: () =>
        openCodeDb("message", [{ id: "m1", sessionId: "s1", at, data: assistant() }]).db,
    });
    const result = await reader.read(ctx(fakeFs({ [DATA]: names })));
    expect(result.report.status).toBe("partial");
    expect(result.report.files).toBe(ImportTuning.filesPerScan);
    expect(result.report.note).toContain("left out to bound the scan");
  });

  it("never selects prompts, paths or credential tables", async () => {
    const { db, sql } = openCodeDb("message", [
      { id: "m1", sessionId: "s1", at, data: assistant() },
    ]);
    const reader = createOpenCodeHistoryReader({ openDatabase: () => db });
    const result = await reader.read(ctx(files));
    const serialized = JSON.stringify(result);
    for (const secret of [SECRET_PROMPT, SECRET_PATH, SECRET_KEY, SECRET_SYSTEM, SECRET_SUMMARY]) {
      expect(serialized).not.toContain(secret);
    }
    const queries = sql.join("\n");
    expect(queries).not.toMatch(/\*|\$\.path|\$\.content|credential|session_input|prompt|account/i);
    expect(queries).not.toMatch(/select[^;]*[ ,]data[ ,]/i);
    expect(queries).toContain("$.tokens.input");
  });
});
