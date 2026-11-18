import { describe, expect, it, vi } from "vitest";
import {
  ImportTuning,
  type HistoryFs,
  type HistoryReaderContext,
  type HistoryStat,
} from "../history-reader.ts";
import { claudeHistoryReader } from "./claude.ts";

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
  } = {},
): HistoryReaderContext {
  return {
    homeDir: options.homeDir ?? "/home/user",
    env: options.env ?? {},
    sinceMs: options.sinceMs ?? 0,
    untilMs: options.untilMs ?? Number.MAX_SAFE_INTEGER,
    signal: options.signal ?? new AbortController().signal,
    fs,
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
    const home = "/home/user";
    const header = `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-18T12:00:00.000Z",
      sessionId: "sess-privacy",
      accountUuid: leakAccount,
      message: { content: [{ type: "text", text: leakPrompt }] },
    })}\n`;
    const { fs } = claudeTree(home, [
      {
        rel: "privacy.jsonl",
        content: header + assistantLine({ sessionId: "sess-privacy" }),
        mtimeMs: FRESH_MTIME,
      },
    ]);
    const read = await claudeHistoryReader.read(
      ctx(fs, { homeDir: home, sinceMs: WINDOW_SINCE, untilMs: WINDOW_UNTIL }),
    );
    const blob = JSON.stringify(read);
    expect(blob).not.toContain(leakPrompt);
    expect(blob).not.toContain(leakAccount);
    expect(read.records).toHaveLength(1);
  });
});
