import { describe, expect, it } from "vitest";
import { ImportTuning, type HistoryFs, type HistoryReaderContext } from "../history-reader.ts";
import { codexHistoryReader } from "./codex.ts";

const HOME = "/home/tester";
const SESSIONS = `${HOME}/.codex/sessions`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const SECRET_PROMPT = "FAKE-PROMPT-delete-the-production-database";
const SECRET_KEY = "FAKE-CREDENTIAL-codex-token-000";
const SECRET_INSTRUCTIONS = "FAKE-BASE-INSTRUCTIONS-never-ship-this";
const SECRET_SUMMARY = "FAKE-TURN-SUMMARY-leaked-roadmap-notes";

type FileSpec = { body: string; mtimeMs?: number };

function fakeFs(files: Record<string, FileSpec>): HistoryFs {
  const dirs = new Map<string, Set<string>>();
  for (const file of Object.keys(files)) {
    const parts = file.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const parent = "/" + parts.slice(0, i).join("/");
      const names = dirs.get(parent) ?? new Set<string>();
      names.add(parts[i] ?? "");
      dirs.set(parent, names);
    }
  }
  const gone = (): never => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  return {
    readFile: async (target) => {
      const spec = files[target];
      return spec ? new TextEncoder().encode(spec.body) : gone();
    },
    readdir: async (dir) => [...(dirs.get(dir) ?? gone())],
    stat: async (target) => {
      const spec = files[target];
      if (spec) {
        return {
          size: spec.body.length,
          mtimeMs: spec.mtimeMs ?? NOW,
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      return dirs.has(target)
        ? { size: 0, mtimeMs: NOW, isFile: () => false, isDirectory: () => true }
        : gone();
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

const iso = (ms: number) => new Date(ms).toISOString();

function counters(input: number, cached: number, output: number, reasoning = 0, cacheWrite = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

const meta = (id: string, ms: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: iso(ms), type: "session_meta", payload: { id, ...extra } });
const turn = (model: string, ms: number) =>
  JSON.stringify({
    timestamp: iso(ms),
    type: "turn_context",
    payload: { model, cwd: SECRET_KEY, summary: SECRET_SUMMARY },
  });
const tokenCount = (
  ms: number,
  total: ReturnType<typeof counters> | null,
  last: ReturnType<typeof counters> | null,
) =>
  JSON.stringify({
    timestamp: iso(ms),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
    },
  });
const chatter = (ms: number) =>
  JSON.stringify({
    timestamp: iso(ms),
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ text: SECRET_PROMPT }] },
  });

const FILE = `${SESSIONS}/2026/06/09/rollout-one.jsonl`;
const read = (body: string, patch: Partial<HistoryReaderContext> = {}) =>
  codexHistoryReader.read(ctx(fakeFs({ [FILE]: { body } }), patch));
const t0 = NOW - DAY;

describe("codex history reader", () => {
  it("maps cumulative counters to per-event deltas with uncached input", async () => {
    const body = [
      meta("sess-1", t0),
      turn("gpt-5-codex", t0 + 1),
      chatter(t0 + 2),
      tokenCount(t0 + 10_000, counters(1000, 800, 100, 30), counters(1000, 800, 100, 30)),
      tokenCount(t0 + 20_000, counters(1500, 1100, 160, 40), counters(500, 300, 60, 10)),
      tokenCount(t0 + 30_000, counters(1500, 1100, 160, 40), counters(500, 300, 60, 10)),
    ].join("\n");
    const result = await read(body);
    expect(result.report).toEqual({ origin: "codex", status: "ok", files: 1 });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      origin: "codex",
      model: "gpt-5-codex",
      sessionKey: "sess-1",
      at: t0 + 10_000,
      inputTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 30,
    });
    expect(result.records[1]).toMatchObject({
      at: t0 + 20_000,
      inputTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 60,
      reasoningTokens: 10,
    });
    const keys = result.records.map((r) => r.dedupeKey);
    expect(keys[0]).toBeTypeOf("string");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("subtracts cache writes from input and reads CODEX_HOME", async () => {
    const body = [
      meta("sess-w", t0),
      turn("gpt-5", t0 + 1),
      tokenCount(t0 + 5000, counters(1000, 600, 50, 0, 150), null),
    ].join("\n");
    const file = "/custom/codex/sessions/a.jsonl";
    const result = await codexHistoryReader.read(
      ctx(fakeFs({ [file]: { body } }), { env: { CODEX_HOME: "/custom/codex" } }),
    );
    expect(result.records[0]).toMatchObject({
      inputTokens: 250,
      cacheReadTokens: 600,
      cacheWriteTokens: 150,
    });
  });

  it("re-baselines on a counter reset instead of emitting a negative delta", async () => {
    const body = [
      meta("sess-r", t0),
      turn("gpt-5", t0 + 1),
      tokenCount(t0 + 10_000, counters(1000, 0, 100), counters(1000, 0, 100)),
      tokenCount(t0 + 20_000, counters(1600, 0, 150), counters(600, 0, 50)),
      // Resumed in a new process: the counters restart at this request.
      tokenCount(t0 + 30_000, counters(300, 0, 20), counters(300, 0, 20)),
      tokenCount(t0 + 40_000, counters(500, 0, 50), counters(200, 0, 30)),
      // Older snapshot replayed: not billed and baseline stays at the prior cumulative (700).
      tokenCount(t0 + 50_000, counters(100, 0, 5), counters(400, 0, 40)),
      tokenCount(t0 + 60_000, counters(700, 0, 70), counters(200, 0, 20)),
    ].join("\n");
    const { records } = await read(body);
    expect(records.map((r) => [r.inputTokens, r.outputTokens])).toEqual([
      [1000, 100],
      [600, 50],
      [300, 20],
      [200, 30],
      [200, 20],
    ]);
  });

  it("does not bill a forked session for its copied parent history", async () => {
    const copied = [
      tokenCount(t0 + 100, counters(1000, 0, 100), counters(1000, 0, 100)),
      tokenCount(t0 + 120, counters(2000, 0, 200), counters(1000, 0, 100)),
      tokenCount(t0 + 140, counters(3000, 0, 300), counters(1000, 0, 100)),
    ];
    const body = [
      meta("child", t0, { forked_from_id: "parent" }),
      turn("gpt-5", t0 + 1),
      ...copied,
      tokenCount(t0 + 9000, counters(3400, 0, 340), counters(400, 0, 40)),
    ].join("\n");
    const { records } = await read(body);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sessionKey: "child", inputTokens: 400, outputTokens: 40 });
  });

  it("treats a subagent thread spawn as a fork", async () => {
    const body = [
      meta("sub", t0, { source: { subagent: { thread_spawn: { parent_thread_id: "p" } } } }),
      turn("gpt-5", t0 + 1),
      tokenCount(t0 + 50, counters(900, 0, 90), counters(900, 0, 90)),
      tokenCount(t0 + 7000, counters(1000, 0, 100), counters(100, 0, 10)),
    ].join("\n");
    const { records } = await read(body);
    expect(records.map((r) => r.inputTokens)).toEqual([100]);
  });

  it("returns missing when there is no Codex sessions directory", async () => {
    const result = await codexHistoryReader.read(ctx(fakeFs({})));
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("missing");
  });

  it("skips malformed usage and bad lines and reports partial", async () => {
    const body = [
      meta("sess-m", t0),
      turn("gpt-5", t0 + 1),
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":"x","output_tokens":1}}}',
      tokenCount(t0 + 2000, { ...counters(10, 0, 1), input_tokens: -5 }, null),
      tokenCount(t0 + 3000, counters(100, 0, 10), counters(100, 0, 10)),
    ].join("\n");
    const result = await read(body);
    expect(result.records).toHaveLength(1);
    expect(result.report.status).toBe("partial");
    expect(result.report.note).toContain("2 usage entries were unreadable");
  });

  it("skips lines over the size limit and reports partial", async () => {
    const huge = tokenCount(t0 + 1000, counters(1, 0, 1), counters(1, 0, 1)).replace(
      '"info"',
      `"pad":"${"a".repeat(ImportTuning.maxLineBytes)}","info"`,
    );
    const body = [
      meta("sess-big", t0),
      turn("gpt-5", t0 + 1),
      huge,
      tokenCount(t0 + 2000, counters(50, 0, 5), counters(50, 0, 5)),
    ].join("\n");
    const result = await read(body);
    expect(result.records.map((r) => r.inputTokens)).toEqual([50]);
    expect(result.report.status).toBe("partial");
    expect(result.report.note).toContain("1 oversized lines were skipped");
  });

  it("applies the window as [sinceMs, untilMs) but keeps the baseline from earlier events", async () => {
    const since = NOW - 7 * DAY;
    const body = [
      meta("sess-w", since - DAY),
      turn("gpt-5", since - DAY + 1),
      tokenCount(since - 1, counters(1000, 0, 100), counters(1000, 0, 100)),
      tokenCount(since, counters(1300, 0, 130), counters(300, 0, 30)),
      tokenCount(NOW + DAY - 1, counters(1600, 0, 160), counters(300, 0, 30)),
      tokenCount(NOW + DAY, counters(1900, 0, 190), counters(300, 0, 30)),
    ].join("\n");
    const { records } = await read(body, { sinceMs: since, untilMs: NOW + DAY });
    expect(records.map((r) => r.at)).toEqual([since, NOW + DAY - 1]);
    expect(records.map((r) => r.inputTokens)).toEqual([300, 300]);
  });

  it("filters files by mtime slack", async () => {
    const body = [
      meta("s", t0),
      turn("m", t0 + 1),
      tokenCount(t0 + 9, counters(10, 0, 1), counters(10, 0, 1)),
    ].join("\n");
    const old = await codexHistoryReader.read(
      ctx(fakeFs({ [FILE]: { body, mtimeMs: NOW - 30 * DAY } })),
    );
    expect(old.report).toEqual({ origin: "codex", status: "ok", files: 0 });
    expect(old.records).toEqual([]);
  });

  it("stops and reports partial when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const body = [
      meta("s", t0),
      turn("m", t0 + 1),
      tokenCount(t0 + 9, counters(10, 0, 1), counters(10, 0, 1)),
    ].join("\n");
    const result = await read(body, { signal: controller.signal });
    expect(result.records).toEqual([]);
    expect(result.report.status).toBe("partial");
  });

  it("never keeps message text, paths or credentials", async () => {
    const body = [
      meta("sess-p", t0, {
        cwd: SECRET_KEY,
        instructions: SECRET_PROMPT,
        base_instructions: SECRET_INSTRUCTIONS,
      }),
      turn("gpt-5", t0 + 1),
      chatter(t0 + 2),
      tokenCount(t0 + 3000, counters(100, 20, 10), counters(100, 20, 10)),
    ].join("\n");
    const result = await read(body);
    expect(result.records).toHaveLength(1);
    const serialized = JSON.stringify(result);
    for (const secret of [SECRET_PROMPT, SECRET_KEY, SECRET_INSTRUCTIONS, SECRET_SUMMARY]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(FILE);
  });
});
