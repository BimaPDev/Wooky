import { describe, expect, it, vi } from "vitest";
import {
  ImportTuning,
  type HistoryFileCache,
  type HistoryFileStat,
  type HistoryFs,
  type HistoryReaderContext,
  type HistoryRecord,
  type HistoryStat,
} from "../history-reader.ts";
import { claudeHistoryReader, readLinesForTest } from "./claude.ts";

const HISTORY_RECORD_KEYS = new Set([
  "origin",
  "model",
  "sessionKey",
  "at",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "outputTokens",
  "reasoningTokens",
  "reportedCostUsd",
  "dedupeKey",
]);

const REPORT_KEYS = new Set(["origin", "status", "files", "note"]);

const READ_CHUNK_BYTES = 256 * 1024;

const encoder = new TextEncoder();

interface FsNode {
  stat: HistoryStat;
  body?: Uint8Array;
  children?: Map<string, FsNode>;
}

function fileStat(size: number, mtimeMs: number): HistoryStat {
  return {
    size,
    mtimeMs,
    isFile: () => true,
    isDirectory: () => false,
  };
}

function dirStat(mtimeMs = 0): HistoryStat {
  return {
    size: 0,
    mtimeMs,
    isFile: () => false,
    isDirectory: () => true,
  };
}

function makeFs(root: string, tree: FsNode): HistoryFs {
  const resolve = (path: string): FsNode => {
    const rel = path.startsWith(root) ? path.slice(root.length).replace(/^\//, "") : path;
    if (rel === "" || rel === ".") return tree;
    let node = tree;
    for (const part of rel.split("/").filter(Boolean)) {
      if (!node.children?.has(part)) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      const child = node.children.get(part);
      if (!child) {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      node = child;
    }
    return node;
  };

  return {
    readFile(path) {
      const node = resolve(path);
      if (!node.stat.isFile()) {
        const error = new Error("EISDIR") as NodeJS.ErrnoException;
        error.code = "EISDIR";
        return Promise.reject(error);
      }
      return Promise.resolve(node.body ?? new Uint8Array());
    },
    stat(path) {
      return Promise.resolve(resolve(path).stat);
    },
    readdir(path) {
      const node = resolve(path);
      if (!node.stat.isDirectory()) {
        const error = new Error("ENOTDIR") as NodeJS.ErrnoException;
        error.code = "ENOTDIR";
        return Promise.reject(error);
      }
      return Promise.resolve([...(node.children?.keys() ?? [])]);
    },
  };
}

function ctx(
  fs: HistoryFs,
  options: {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    sinceMs?: number;
    untilMs?: number;
    signal?: AbortSignal;
    fileCache?: HistoryFileCache;
  } = {},
): HistoryReaderContext {
  return {
    homeDir: options.homeDir ?? "/home/user",
    env: options.env ?? {},
    sinceMs: options.sinceMs ?? 0,
    untilMs: options.untilMs ?? Number.MAX_SAFE_INTEGER,
    signal: options.signal ?? new AbortController().signal,
    fs,
    ...(options.fileCache === undefined ? {} : { fileCache: options.fileCache }),
  };
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
  const base = {
    type: "assistant",
    timestamp: "2026-11-18T12:00:00.000Z",
    sessionId: "sess-normal",
    requestId: "req-1",
    message: {
      id: "msg-1",
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 5,
      },
    },
  };
  return `${JSON.stringify({ ...base, ...overrides })}\n`;
}

function childMap(node: FsNode): Map<string, FsNode> {
  if (!node.children) node.children = new Map();
  return node.children;
}

function claudeTree(
  homeDir: string,
  files: { rel: string; content: string; mtimeMs: number }[],
): { fs: HistoryFs; projectsDir: string } {
  const projects: FsNode = { stat: dirStat(), children: new Map() };
  for (const file of files) {
    const segments = file.rel.split("/");
    const fileName = segments.at(-1);
    if (!fileName) continue;
    const parts = segments.slice(0, -1);
    let dir = projects;
    for (const part of parts) {
      const children = childMap(dir);
      if (!children.has(part)) {
        children.set(part, { stat: dirStat(), children: new Map() });
      }
      const next = children.get(part);
      if (!next) continue;
      dir = next;
    }
    const body = encoder.encode(file.content);
    childMap(dir).set(fileName, { stat: fileStat(body.byteLength, file.mtimeMs), body });
  }

  const fs = makeFs(homeDir, {
    stat: dirStat(),
    children: new Map([
      [".claude", { stat: dirStat(), children: new Map([["projects", projects]]) }],
    ]),
  });
  return { fs, projectsDir: `${homeDir}/.claude/projects` };
}

const WINDOW_SINCE = Date.parse("2026-11-18T00:00:00.000Z");
const WINDOW_UNTIL = Date.parse("2026-11-19T00:00:00.000Z");
const FRESH_MTIME = WINDOW_SINCE;

describe("claudeHistoryReader", () => {
  it("parses a normal assistant usage line", async () => {
    const home = "/home/user";
    const { fs } = claudeTree(home, [
      { rel: "proj/a.jsonl", content: assistantLine({ costUSD: 0.12 }), mtimeMs: FRESH_MTIME },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );

    expect(read.report).toEqual({ origin: "claude", status: "ok", files: 1 });
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toEqual({
      origin: "claude",
      model: "claude-opus-4-6",
      sessionKey: "sess-normal",
      at: Date.parse("2026-11-18T12:00:00.000Z"),
      inputTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      outputTokens: 5,
      reportedCostUsd: 0.12,
      dedupeKey: "msg-1:req-1",
    });
  });

  it("splits 1-hour cache writes out of cache_creation", async () => {
    const home = "/home/user";
    const line = assistantLine({
      message: {
        id: "msg-cache",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 8,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 100,
          cache_creation: {
            ephemeral_5m_input_tokens: 40,
            ephemeral_1h_input_tokens: 60,
          },
          output_tokens: 2,
        },
      },
    });
    const { fs } = claudeTree(home, [{ rel: "proj/a.jsonl", content: line, mtimeMs: FRESH_MTIME }]);
    const { records } = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(records[0]).toMatchObject({
      cacheWriteTokens: 100,
      cacheWrite1hTokens: 60,
    });
  });

  it("repeats assistant blocks with the same dedupeKey", async () => {
    const home = "/home/user";
    const lineA = assistantLine({
      message: {
        id: "msg-dup",
        model: "claude-sonnet-4",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const lineB = assistantLine({
      message: {
        id: "msg-dup",
        model: "claude-sonnet-4",
        usage: { input_tokens: 1, output_tokens: 9 },
      },
    });
    const { fs } = claudeTree(home, [
      { rel: "dup.jsonl", content: lineA + lineB, mtimeMs: FRESH_MTIME },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );

    expect(read.records).toHaveLength(2);
    expect(read.records[0]?.dedupeKey).toBe("msg-dup:req-1");
    expect(read.records[1]?.dedupeKey).toBe("msg-dup:req-1");
    expect(read.records[1]?.outputTokens).toBe(9);
  });

  it("skips the synthetic model", async () => {
    const home = "/home/user";
    const { fs } = claudeTree(home, [
      {
        rel: "syn.jsonl",
        content: assistantLine({
          message: {
            id: "msg-syn",
            model: "<synthetic>",
            usage: { input_tokens: 4, output_tokens: 1 },
          },
        }),
        mtimeMs: FRESH_MTIME,
      },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.records).toHaveLength(0);
  });

  it("silently skips malformed lines", async () => {
    const home = "/home/user";
    const { fs } = claudeTree(home, [
      { rel: "bad.jsonl", content: `{not json\n${assistantLine()}`, mtimeMs: FRESH_MTIME },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.records).toHaveLength(1);
    expect(read.report.status).toBe("ok");
  });

  it("marks partial when a line exceeds maxLineBytes", async () => {
    const home = "/home/user";
    const padding = "x".repeat(ImportTuning.maxLineBytes + 1);
    const { fs } = claudeTree(home, [
      { rel: "big.jsonl", content: `${padding}\n${assistantLine()}`, mtimeMs: FRESH_MTIME },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.report.status).toBe("partial");
    expect(read.records).toHaveLength(1);
  });

  it("never parses lines that lack the usage marker", async () => {
    const home = "/home/user";
    const poison = '{"type":"user","text":"SECRET_PROMPT_LEAK"}\n';
    const { fs } = claudeTree(home, [
      { rel: "marker.jsonl", content: poison, mtimeMs: FRESH_MTIME },
    ]);
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const read = await claudeHistoryReader.read(
        ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
      );
      expect(read.records).toHaveLength(0);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("skips files older than the mtime slack", async () => {
    const home = "/home/user";
    const staleMtime = WINDOW_SINCE - ImportTuning.mtimeSlackMs - 1;
    const { fs } = claudeTree(home, [
      { rel: "stale.jsonl", content: assistantLine(), mtimeMs: staleMtime },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.records).toHaveLength(0);
    expect(read.report.files).toBe(0);
  });

  it("filters records to the since/until window", async () => {
    const home = "/home/user";
    const inWindow = assistantLine({ timestamp: "2026-11-18T15:00:00.000Z" });
    const outWindow = assistantLine({
      timestamp: "2026-11-19T01:00:00.000Z",
      sessionId: "sess-out",
    });
    const { fs } = claudeTree(home, [
      { rel: "win.jsonl", content: inWindow + outWindow, mtimeMs: FRESH_MTIME },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.sessionKey).toBe("sess-normal");
  });

  it("reports missing when the projects directory is absent", async () => {
    const fs: HistoryFs = {
      readFile: () => Promise.resolve(new Uint8Array()),
      stat: () => {
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        return Promise.reject(error);
      },
      readdir: () => Promise.resolve([]),
    };
    const read = await claudeHistoryReader.read(ctx(fs));
    expect(read.report).toEqual({ origin: "claude", status: "missing", files: 0 });
    expect(read.records).toHaveLength(0);
  });

  it("honours CLAUDE_CONFIG_DIR over the default home", async () => {
    const custom = "/cfg/claude";
    const projects: FsNode = { stat: dirStat(), children: new Map() };
    const body = encoder.encode(assistantLine({ sessionId: "sess-custom" }));
    projects.children?.set("custom.jsonl", { stat: fileStat(body.byteLength, FRESH_MTIME), body });
    const fs = makeFs(custom, {
      stat: dirStat(),
      children: new Map([["projects", projects]]),
    });
    const read = await claudeHistoryReader.read(
      ctx(fs, {
        homeDir: "/home/user",
        env: { CLAUDE_CONFIG_DIR: custom },
        sinceMs: WINDOW_SINCE,
        untilMs: WINDOW_UNTIL,
      }),
    );
    expect(read.records[0]?.sessionKey).toBe("sess-custom");
  });

  it("stops when the abort signal is set", async () => {
    const home = "/home/user";
    const many = Array.from({ length: 5 }, (_, i) => ({
      rel: `batch/f-${i}.jsonl`,
      content: assistantLine({ sessionId: `sess-${i}` }),
      mtimeMs: FRESH_MTIME,
    }));
    const { fs } = claudeTree(home, many);
    const controller = new AbortController();
    controller.abort();
    const read = await claudeHistoryReader.read(
      ctx(fs, {
        homeDir: home,
        sinceMs: WINDOW_SINCE,
        untilMs: WINDOW_UNTIL,
        signal: controller.signal,
      }),
    );
    expect(read.records).toHaveLength(0);
    expect(read.report.status).toBe("partial");
  });

  it("caps files per scan and reports partial", async () => {
    const home = "/home/user";
    const files = Array.from({ length: ImportTuning.filesPerScan + 2 }, (_, i) => ({
      rel: `cap/${i}.jsonl`,
      content: assistantLine({ sessionId: `sess-cap-${i}` }),
      mtimeMs: FRESH_MTIME,
    }));
    const { fs } = claudeTree(home, files);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.report.status).toBe("partial");
    expect(read.report.files).toBe(ImportTuning.filesPerScan);
    expect(read.records).toHaveLength(ImportTuning.filesPerScan);
  });

  it("does not retain prompt text or account identifiers from transcript lines", async () => {
    const leakPrompt = "RECOGNISABLE_FAKE_PROMPT_DO_NOT_LEAK";
    const leakAccount = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const leakCwd = "/secret/abs/path/project";
    const leakBranch = "feature/top-secret-branch";
    const leakTool = "RECOGNISABLE_FAKE_TOOL_OUTPUT_DO_NOT_LEAK";
    const home = "/home/user";
    const tainted = assistantLine({
      sessionId: "sess-privacy",
      accountUuid: leakAccount,
      cwd: leakCwd,
      gitBranch: leakBranch,
      message: {
        id: "msg-privacy",
        model: "claude-opus-4-6",
        content: [
          { type: "text", text: leakPrompt },
          { type: "tool_result", content: leakTool },
        ],
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 4,
        },
      },
    });
    const { fs } = claudeTree(home, [
      { rel: "privacy.jsonl", content: tainted, mtimeMs: FRESH_MTIME },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    const blob = JSON.stringify(read);
    expect(blob).not.toContain(leakPrompt);
    expect(blob).not.toContain(leakAccount);
    expect(blob).not.toContain(leakCwd);
    expect(blob).not.toContain(leakBranch);
    expect(blob).not.toContain(leakTool);
    expect(read.records).toHaveLength(1);
    const requiredRecordKeys = [
      "origin",
      "model",
      "sessionKey",
      "at",
      "inputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outputTokens",
    ] as const;
    for (const record of read.records) {
      const keys = Object.keys(record);
      for (const key of keys) {
        expect(HISTORY_RECORD_KEYS.has(key)).toBe(true);
      }
      for (const key of requiredRecordKeys) {
        expect(keys).toContain(key);
      }
    }
    for (const key of Object.keys(read.report)) {
      expect(REPORT_KEYS.has(key)).toBe(true);
    }
  });

  it("returns valid lines and partial status for a 40 MB oversized line without unbounded buffering", async () => {
    const home = "/home/user";
    const giant = `${"y".repeat(40 * 1024 * 1024)}\n`;
    const first = assistantLine({ sessionId: "sess-before-giant" });
    const last = assistantLine({ sessionId: "sess-after-giant" });
    const { fs } = claudeTree(home, [
      { rel: "giant.jsonl", content: first + giant + last, mtimeMs: FRESH_MTIME },
    ]);
    let peakCarry = 0;
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.report.status).toBe("partial");
    expect(read.records).toHaveLength(2);
    expect(read.records[0]?.sessionKey).toBe("sess-before-giant");
    expect(read.records[1]?.sessionKey).toBe("sess-after-giant");

    const projectsPath = `${home}/.claude/projects/giant.jsonl`;
    await readLinesForTest(projectsPath, ctx(fs), () => {}, {
      onPeakCarryBytes: (peak) => {
        peakCarry = peak;
      },
    });
    expect(peakCarry).toBeLessThanOrEqual(ImportTuning.maxLineBytes + READ_CHUNK_BYTES);
  });

  it("skips an oversized line that ends exactly at a chunk boundary with bounded carry", async () => {
    const home = "/home/user";
    const lineBodyBytes = ImportTuning.maxLineBytes + 1;
    const padToChunk =
      READ_CHUNK_BYTES - ((lineBodyBytes + 1) % READ_CHUNK_BYTES || READ_CHUNK_BYTES);
    const oversized = `${"z".repeat(lineBodyBytes + padToChunk)}\n`;
    expect((lineBodyBytes + padToChunk + 1) % READ_CHUNK_BYTES).toBe(0);
    const before = assistantLine({ sessionId: "sess-chunk-before" });
    const after = assistantLine({ sessionId: "sess-chunk-after" });
    const { fs } = claudeTree(home, [
      { rel: "chunk-edge.jsonl", content: before + oversized + after, mtimeMs: FRESH_MTIME },
    ]);
    let peakCarry = 0;
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.report.status).toBe("partial");
    expect(read.records).toHaveLength(2);
    expect(read.records[0]?.sessionKey).toBe("sess-chunk-before");
    expect(read.records[1]?.sessionKey).toBe("sess-chunk-after");

    const path = `${home}/.claude/projects/chunk-edge.jsonl`;
    await readLinesForTest(path, ctx(fs), () => {}, {
      onPeakCarryBytes: (peak) => {
        peakCarry = peak;
      },
    });
    expect(peakCarry).toBeLessThanOrEqual(ImportTuning.maxLineBytes + READ_CHUNK_BYTES);
  });

  it("skips a file that disappears before stat and keeps other files", async () => {
    const home = "/home/user";
    const { fs: inner, projectsDir } = claudeTree(home, [
      {
        rel: "kept.jsonl",
        content: assistantLine({ sessionId: "sess-kept" }),
        mtimeMs: FRESH_MTIME,
      },
      {
        rel: "vanished.jsonl",
        content: assistantLine({ sessionId: "sess-vanished" }),
        mtimeMs: FRESH_MTIME,
      },
    ]);
    const vanishPath = `${projectsDir}/vanished.jsonl`;
    let statCalls = 0;
    const fs: HistoryFs = {
      ...inner,
      async stat(path) {
        if (path === vanishPath) {
          statCalls += 1;
          if (statCalls >= 2) {
            const error = new Error("ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
        }
        return inner.stat(path);
      },
    };
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.sessionKey).toBe("sess-kept");
    expect(read.report.status).toBe("ok");
  });

  it("does not re-read a file when fileCache returns a hit", async () => {
    const home = "/home/user";
    const { fs: inner } = claudeTree(home, [
      { rel: "cache-hit.jsonl", content: assistantLine(), mtimeMs: FRESH_MTIME },
    ]);
    let readCount = 0;
    const fs: HistoryFs = {
      ...inner,
      readFile(path) {
        readCount += 1;
        return inner.readFile(path);
      },
    };
    const store = new Map<string, { stat: HistoryFileStat; records: HistoryRecord[] }>();
    const fileCache: HistoryFileCache = {
      get(path, stat) {
        const hit = store.get(path);
        if (hit === undefined || hit.stat.size !== stat.size || hit.stat.mtimeMs !== stat.mtimeMs) {
          return undefined;
        }
        return hit.records;
      },
      set(path, stat, records) {
        store.set(path, { stat, records });
      },
    };
    const base = ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL });
    const warm = await claudeHistoryReader.read({ ...base, fileCache });
    expect(warm.records).toHaveLength(1);
    expect(readCount).toBe(1);

    readCount = 0;
    const again = await claudeHistoryReader.read({ ...base, fileCache });
    expect(again.records).toHaveLength(1);
    expect(readCount).toBe(0);
  });

  it("re-reads and re-sets when size or mtime changes", async () => {
    const home = "/home/user";
    const fileName = "mtime.jsonl";
    const firstBody = assistantLine({
      message: {
        id: "msg-a",
        model: "claude-sonnet-4",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    const { fs: inner, projectsDir } = claudeTree(home, [
      { rel: fileName, content: firstBody, mtimeMs: FRESH_MTIME },
    ]);
    const filePath = `${projectsDir}/${fileName}`;
    let body = firstBody;
    let mtimeMs = FRESH_MTIME;
    const fs: HistoryFs = {
      ...inner,
      readFile(path) {
        if (path === filePath) return Promise.resolve(encoder.encode(body));
        return inner.readFile(path);
      },
      async stat(path) {
        if (path === filePath) {
          const data = encoder.encode(body);
          return fileStat(data.byteLength, mtimeMs);
        }
        return inner.stat(path);
      },
    };
    const sets: Array<{ size: number; mtimeMs: number; count: number }> = [];
    const fileCache: HistoryFileCache = {
      get() {
        return undefined;
      },
      set(_path, stat, records) {
        sets.push({ size: stat.size, mtimeMs: stat.mtimeMs, count: records.length });
      },
    };
    const base = ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL });
    const first = await claudeHistoryReader.read({ ...base, fileCache });
    expect(first.records[0]?.outputTokens).toBe(2);
    expect(sets).toHaveLength(1);

    body =
      firstBody +
      assistantLine({
        message: {
          id: "msg-b",
          model: "claude-sonnet-4",
          usage: { input_tokens: 3, output_tokens: 9 },
        },
      });
    mtimeMs = FRESH_MTIME + 1;
    const second = await claudeHistoryReader.read({ ...base, fileCache });
    expect(second.records).toHaveLength(2);
    expect(sets).toHaveLength(2);
    expect(sets[1]?.size).not.toBe(sets[0]?.size);
    expect(sets[1]?.mtimeMs).toBe(FRESH_MTIME + 1);
  });

  it("does not store partial files in fileCache", async () => {
    const home = "/home/user";
    const padding = "x".repeat(ImportTuning.maxLineBytes + 1);
    const { fs } = claudeTree(home, [
      {
        rel: "partial-cache.jsonl",
        content: `${padding}\n${assistantLine()}`,
        mtimeMs: FRESH_MTIME,
      },
    ]);
    const set = vi.fn<HistoryFileCache["set"]>();
    const fileCache: HistoryFileCache = {
      get: () => undefined,
      set,
    };
    await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL, fileCache }),
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("marks partial when a file read fails and continues without leaking the path", async () => {
    const home = "/home/user";
    const { fs: inner, projectsDir } = claudeTree(home, [
      {
        rel: "good.jsonl",
        content: assistantLine({ sessionId: "sess-good" }),
        mtimeMs: FRESH_MTIME,
      },
      { rel: "bad.jsonl", content: assistantLine({ sessionId: "sess-bad" }), mtimeMs: FRESH_MTIME },
    ]);
    const badPath = `${projectsDir}/bad.jsonl`;
    const fs: HistoryFs = {
      ...inner,
      async readFile(path) {
        if (path === badPath) {
          const error = new Error("EIO") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        return inner.readFile(path);
      },
    };
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    expect(read.records).toHaveLength(1);
    expect(read.records[0]?.sessionKey).toBe("sess-good");
    expect(read.report.status).toBe("partial");
    expect(read.report.note).toBe("Scan stopped before all transcript files were read.");
    expect(read.report.note).not.toContain(badPath);
    expect(JSON.stringify(read)).not.toContain(badPath);
  });
});
