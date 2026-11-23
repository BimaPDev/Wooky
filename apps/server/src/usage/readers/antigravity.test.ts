import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { HistoryFs, HistoryReaderContext } from "../history-reader.ts";
import {
  antigravityHistoryReader,
  createAntigravityHistoryReader,
  parseGenerationMetadata,
  parseStepMetadata,
} from "./antigravity.ts";
import type { ReadOnlyDb } from "./cursor.ts";

const HOME = "/home/tester";
const CONV = `${HOME}/.gemini/antigravity/conversations`;
const DB = `${CONV}/sess-1.db`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const AT_SEC = Math.floor((NOW - DAY) / 1000);

const norm = (value: string) => value.replaceAll("\\", "/");

function fakeFs(files: Record<string, number>): HistoryFs {
  const byPath = new Map<string, number>();
  const dirs = new Map<string, Set<string>>();
  const add = (parent: string, child: string) => {
    const names = dirs.get(parent) ?? new Set<string>();
    names.add(child);
    dirs.set(parent, names);
  };
  for (const [raw, mtimeMs] of Object.entries(files)) {
    const file = norm(raw);
    byPath.set(file, mtimeMs);
    const parts = file.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      add("/" + parts.slice(0, i).join("/"), parts[i] ?? "");
    }
  }
  const missing = (): never => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  return {
    readFile: async () => new Uint8Array(),
    readdir: async (dir) => {
      const names = dirs.get(norm(dir));
      return names ? [...names] : missing();
    },
    stat: async (target) => {
      const normalized = norm(target);
      const mtimeMs = byPath.get(normalized);
      if (mtimeMs !== undefined) {
        return { size: 1, mtimeMs, isFile: () => true, isDirectory: () => false };
      }
      if (dirs.has(normalized)) {
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

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function varint(value: number): Uint8Array {
  const digits: number[] = [];
  let remaining = BigInt(value);
  while (remaining >= 0x80n) {
    digits.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  digits.push(Number(remaining));
  return Uint8Array.from(digits);
}

function key(field: number, wire: number): Uint8Array {
  return varint(field * 8 + wire);
}

function vint(field: number, value: number): Uint8Array {
  return concat(key(field, 0), varint(value));
}

function packed(field: number, value: Uint8Array): Uint8Array {
  return concat(key(field, 2), varint(value.byteLength), value);
}

function str(field: number, value: string): Uint8Array {
  return packed(field, new TextEncoder().encode(value));
}

function timestamp(seconds: number): Uint8Array {
  return concat(vint(1, seconds), vint(2, 0));
}

function usageBlob(overrides: {
  modelId?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  identity?: string;
}): Uint8Array {
  const parts = [
    vint(1, overrides.modelId ?? 246),
    vint(2, overrides.input ?? 100),
    vint(3, overrides.output ?? 20),
    vint(4, overrides.cacheWrite ?? 5),
    vint(5, overrides.cacheRead ?? 50),
  ];
  if (overrides.identity !== undefined) parts.push(str(11, overrides.identity));
  return concat(...parts);
}

function generationBlob(
  overrides: {
    model?: string;
    modelId?: number;
    usage?: Uint8Array;
    at?: number;
  } = {},
): Uint8Array {
  const usage = overrides.usage ?? usageBlob({ modelId: overrides.modelId, identity: "req-1" });
  const data = concat(
    vint(3, overrides.modelId ?? 246),
    packed(4, usage),
    str(19, overrides.model ?? "gemini-2.5-pro"),
    packed(9, packed(4, timestamp(overrides.at ?? AT_SEC))),
  );
  return packed(1, data);
}

function stepBlob(
  overrides: {
    model?: string;
    modelId?: number;
    usage?: Uint8Array;
    at?: number;
  } = {},
): Uint8Array {
  const usage = overrides.usage ?? usageBlob({ modelId: overrides.modelId, identity: "req-1" });
  return concat(
    packed(
      24,
      concat(vint(1, overrides.modelId ?? 246), str(12, overrides.model ?? "gemini-2.5-pro")),
    ),
    packed(9, usage),
    packed(8, timestamp(overrides.at ?? AT_SEC)),
  );
}

function conversationDb(options: {
  generation?: Uint8Array;
  step?: Uint8Array;
  trajectory?: Uint8Array;
}): { db: ReadOnlyDb; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(
    "CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER); CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB); CREATE TABLE secrets (prompt TEXT)",
  );
  raw.prepare("INSERT INTO secrets VALUES (?)").run("FAKE-ANTIGRAVITY-PROMPT-do-not-leak");
  if (options.generation !== undefined) {
    raw
      .prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)")
      .run(options.generation, options.generation.byteLength);
  }
  if (options.step !== undefined) {
    raw.prepare("INSERT INTO steps (idx, metadata) VALUES (1, ?)").run(options.step);
  }
  if (options.trajectory !== undefined) {
    raw
      .prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('t', ?)")
      .run(options.trajectory);
  }
  return {
    raw,
    db: {
      all: (sql, params = []) => raw.prepare(sql).all(...params) as Record<string, unknown>[],
      close: () => raw.close(),
    },
  };
}

describe("antigravity protobuf parsers", () => {
  it("reads generation usage, cache channels and identity", () => {
    const parsed = parseGenerationMetadata(generationBlob());
    expect(parsed?.model).toBe("gemini-2.5-pro");
    expect(parsed?.usages[0]?.totals).toEqual({
      input: 100,
      cacheRead: 50,
      cacheWrite: 5,
      output: 20,
      reasoning: 0,
    });
    expect(parsed?.usages[0]?.keys).toEqual(["antigravity:11:req-1"]);
  });

  it("reads step metadata and maps a numeric model id", () => {
    const parsed = parseStepMetadata(
      stepBlob({
        model: "",
        modelId: 312,
        usage: usageBlob({ modelId: 312, input: 7, output: 1, cacheRead: 0, cacheWrite: 0 }),
      }),
    );
    expect(parsed?.model).toBe("gemini-2.5-flash");
    expect(parsed?.usages[0]?.totals.input).toBe(7);
  });
});

describe("antigravity history reader", () => {
  it("reads a conversation database and never selects payload columns", async () => {
    const { db } = conversationDb({ generation: generationBlob() });
    const sql: string[] = [];
    const wrapped: ReadOnlyDb = {
      all: (query, params = []) => {
        sql.push(query);
        return db.all(query, params);
      },
      close: db.close,
    };
    const reader = createAntigravityHistoryReader({ openDatabase: () => wrapped });
    const result = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(result.report).toEqual({ origin: "antigravity", status: "ok", files: 1 });
    expect(result.records).toEqual([
      {
        origin: "antigravity",
        model: "gemini-2.5-pro",
        sessionKey: "sess-1",
        at: AT_SEC * 1000,
        inputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 5,
        outputTokens: 20,
        dedupeKey: "antigravity:11:req-1",
      },
    ]);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain("FAKE-ANTIGRAVITY-PROMPT");
    expect(sql.join("\n")).not.toMatch(/prompt|preview|title|step_payload|secrets/i);
  });

  it("merges generation and step rows that share an identity key", async () => {
    const { db } = conversationDb({
      generation: generationBlob({
        usage: usageBlob({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, identity: "same" }),
      }),
      step: stepBlob({
        usage: usageBlob({ input: 40, output: 8, cacheRead: 3, cacheWrite: 1, identity: "same" }),
      }),
    });
    const reader = createAntigravityHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 40,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      dedupeKey: "antigravity:11:same",
    });
  });

  it("reports missing when there is no Antigravity history", async () => {
    const result = await antigravityHistoryReader.read(ctx(fakeFs({})));
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("missing");
  });

  it("skips conversation_summaries databases", async () => {
    const summaries = `${HOME}/.gemini/antigravity/conversation_summaries.db`;
    const opened: string[] = [];
    const reader = createAntigravityHistoryReader({
      openDatabase: (target) => {
        opened.push(target);
        throw new Error("should not open summaries");
      },
    });
    const result = await reader.read(ctx(fakeFs({ [summaries]: NOW })));
    expect(opened).toEqual([]);
    expect(result.report.status).toBe("missing");
  });

  it("applies the window as [sinceMs, untilMs)", async () => {
    const inside = generationBlob({ at: AT_SEC });
    const outside = generationBlob({
      at: Math.floor((NOW - 8 * DAY) / 1000),
      usage: usageBlob({ identity: "old" }),
    });
    const { raw } = conversationDb({ generation: inside });
    raw
      .prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (2, ?, ?)")
      .run(outside, outside.byteLength);
    const db: ReadOnlyDb = {
      all: (sql, params = []) => raw.prepare(sql).all(...params) as Record<string, unknown>[],
      close: () => raw.close(),
    };
    const reader = createAntigravityHistoryReader({ openDatabase: () => db });
    const { records } = await reader.read(ctx(fakeFs({ [DB]: NOW })));
    expect(records.map((row) => row.dedupeKey)).toEqual(["antigravity:11:req-1"]);
  });
});
