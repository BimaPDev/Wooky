import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHistoryService, createWorkerHost } from "./history.ts";
import type { PricingService } from "./pricing.ts";
import type { Origin } from "@wooky/contracts";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 3_600_000;
const FRESH = NOW - HOUR;

const CANARY = {
  claude: { prompt: "FAKE_CANARY_CLAUDE_PROMPT_INT", account: "fake-canary-claude-acct" },
  cursor: { prompt: "FAKE_CANARY_CURSOR_PROMPT_INT", token: "fake-canary-cursor-token" },
  opencode: { prompt: "FAKE_CANARY_OPENCODE_PROMPT_INT", key: "fake-canary-opencode-key" },
  codex: { prompt: "FAKE_CANARY_CODEX_PROMPT_INT", key: "fake-canary-codex-key" },
} as const;

const MODELS = {
  claude: "usage-int-claude",
  cursor: "gpt-4o-cursor-int",
  opencode: "claude-sonnet-int",
  codex: "gpt-5-codex-int",
} as const;

const RATES = Object.fromEntries(
  Object.values(MODELS).map((model) => [
    model,
    { input: 1e-6, output: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  ]),
);

const EXPECTED: Record<
  Exclude<Origin, "antigravity">,
  {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    sessions: number;
    files: number;
  }
> = {
  claude: {
    inputTokens: 11,
    cacheReadTokens: 33,
    cacheWriteTokens: 44,
    outputTokens: 22,
    sessions: 1,
    files: 1,
  },
  cursor: {
    inputTokens: 75,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    outputTokens: 50,
    sessions: 1,
    files: 1,
  },
  opencode: {
    inputTokens: 10,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    outputTokens: 20,
    sessions: 1,
    files: 1,
  },
  codex: {
    inputTokens: 90,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 9,
    sessions: 1,
    files: 1,
  },
};

const pricing = (): PricingService => {
  const snapshot = { table: RATES, status: "ok" as const };
  return { cached: async () => snapshot, load: async () => snapshot };
};

function sumChannels(
  buckets: {
    origin: Origin;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  }[],
  origin: Origin,
) {
  return buckets
    .filter((b) => b.origin === origin)
    .reduce(
      (acc, bucket) => ({
        inputTokens: acc.inputTokens + bucket.inputTokens,
        cacheReadTokens: acc.cacheReadTokens + bucket.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + bucket.cacheWriteTokens,
        outputTokens: acc.outputTokens + bucket.outputTokens,
      }),
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    );
}

let userHome: string;
let ageHome: string;

beforeEach(async () => {
  userHome = await mkdtemp(join(tmpdir(), "age-readers-int-user-"));
  ageHome = await mkdtemp(join(tmpdir(), "age-readers-int-home-"));
});

afterEach(async () => {
  await rm(userHome, { recursive: true, force: true });
  await rm(ageHome, { recursive: true, force: true });
});

async function touch(file: string, mtimeMs: number) {
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

async function seedAllFixtures() {
  const claudeFile = join(userHome, ".claude", "projects", "p", "usage.jsonl");
  await mkdir(join(claudeFile, ".."), { recursive: true });
  const claudeLine = {
    type: "assistant",
    timestamp: new Date(FRESH).toISOString(),
    sessionId: "sess-claude-int",
    requestId: "req-claude-int",
    accountUuid: CANARY.claude.account,
    message: {
      id: "msg-claude-int",
      model: MODELS.claude,
      content: [{ type: "text", text: CANARY.claude.prompt }],
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 33,
        cache_creation_input_tokens: 44,
        output_tokens: 22,
      },
    },
  };
  await writeFile(claudeFile, `${JSON.stringify(claudeLine)}\n`);
  await touch(claudeFile, FRESH);

  const cursorDir = join(userHome, ".cursor", "projects", "p");
  await mkdir(cursorDir, { recursive: true });
  const cursorDb = join(cursorDir, "index.db");
  const db = new DatabaseSync(cursorDb);
  db.exec(
    "CREATE TABLE runs (run_id TEXT, agent_id TEXT, model TEXT, started_at TEXT, created_at TEXT, usage_json TEXT, user_prompt TEXT)",
  );
  db.prepare(
    "INSERT INTO runs (run_id, agent_id, model, started_at, created_at, usage_json, user_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "run-cursor-int",
    "agent-cursor-int",
    MODELS.cursor,
    new Date(FRESH).toISOString(),
    new Date(FRESH).toISOString(),
    JSON.stringify({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      totalTokens: 150,
    }),
    CANARY.cursor.prompt,
  );
  db.exec(
    `CREATE TABLE vault (api_key TEXT); INSERT INTO vault VALUES ('${CANARY.cursor.token}');`,
  );
  db.close();
  await touch(cursorDb, FRESH);

  const ocDir = join(userHome, ".local", "share", "opencode");
  await mkdir(ocDir, { recursive: true });
  const ocDbPath = join(ocDir, "opencode.db");
  const oc = new DatabaseSync(ocDbPath);
  oc.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  oc.exec("CREATE TABLE secrets (prompt TEXT)");
  oc.prepare("INSERT INTO secrets VALUES (?)").run(CANARY.opencode.prompt);
  oc.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "msg-oc-int",
    "sess-oc-int",
    FRESH,
    JSON.stringify({
      role: "assistant",
      modelID: MODELS.opencode,
      content: CANARY.opencode.prompt,
      system: CANARY.opencode.key,
      tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 3, write: 2 } },
    }),
  );
  oc.close();
  await touch(ocDbPath, FRESH);

  const codexFile = join(userHome, ".codex", "sessions", "2026", "11", "int", "rollout-int.jsonl");
  await mkdir(join(codexFile, ".."), { recursive: true });
  const iso = (ms: number) => new Date(ms).toISOString();
  const codexLines = [
    {
      timestamp: iso(FRESH),
      type: "session_meta",
      payload: {
        id: "sess-codex-int",
        cwd: CANARY.codex.key,
        instructions: CANARY.codex.prompt,
      },
    },
    { timestamp: iso(FRESH + 1), type: "turn_context", payload: { model: MODELS.codex } },
    {
      timestamp: iso(FRESH + 2),
      type: "response_item",
      payload: { type: "message", content: [{ text: CANARY.codex.prompt }] },
    },
    {
      timestamp: iso(FRESH + 10),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 90,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 9,
            reasoning_output_tokens: 0,
            total_tokens: 99,
          },
          last_token_usage: {
            input_tokens: 90,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 9,
            reasoning_output_tokens: 0,
            total_tokens: 99,
          },
        },
      },
    },
  ];
  await writeFile(codexFile, codexLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  await touch(codexFile, FRESH);
}

describe("usage history readers integration", () => {
  it("scans all four origins through the worker without leaking planted secrets", async () => {
    await seedAllFixtures();
    const host = createWorkerHost({ home: ageHome, userHome });
    const service = createHistoryService({
      home: ageHome,
      userHome,
      now: () => NOW,
      pricing: pricing(),
      host,
    });

    try {
      const result = await service.get({
        windowDays: 30,
        timeZone: "America/New_York",
        awaitRefresh: true,
      });

      const planted = [
        CANARY.claude.prompt,
        CANARY.claude.account,
        CANARY.cursor.prompt,
        CANARY.cursor.token,
        CANARY.opencode.prompt,
        CANARY.opencode.key,
        CANARY.codex.prompt,
        CANARY.codex.key,
        userHome,
      ];
      const serialized = JSON.stringify(result);
      for (const leak of planted) expect(serialized).not.toContain(leak);

      for (const origin of ["claude", "cursor", "opencode", "codex"] as const) {
        const source = result.sources.find((s) => s.origin === origin);
        expect(source).toMatchObject({ status: "ok", files: EXPECTED[origin].files });
        expect(source?.distinctSessions).toBe(EXPECTED[origin].sessions);
        expect(sumChannels(result.buckets, origin)).toEqual({
          inputTokens: EXPECTED[origin].inputTokens,
          cacheReadTokens: EXPECTED[origin].cacheReadTokens,
          cacheWriteTokens: EXPECTED[origin].cacheWriteTokens,
          outputTokens: EXPECTED[origin].outputTokens,
        });
      }

      const recordsByOrigin = Object.fromEntries(
        (["claude", "cursor", "opencode", "codex"] as const).map((origin) => [
          origin,
          result.buckets.filter((b) => b.origin === origin).reduce((n, b) => n + b.records, 0),
        ]),
      );
      expect(recordsByOrigin).toEqual({ claude: 1, cursor: 1, opencode: 1, codex: 1 });
    } finally {
      await service.close();
    }
  });
});
