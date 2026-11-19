import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, ProviderSettings } from "@wooky/contracts";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeAdapter } from "./claude/adapter.ts";
import { createCodexAdapter } from "./codex/adapter.ts";
import { createCursorAdapter, CURSOR_FAKE_AGENT_SCRIPT } from "./cursor/adapter.ts";
import type { TurnInput } from "./types.ts";

function settings(partial: Partial<ProviderSettings>): ProviderSettings {
  return { customModels: [], extraArgs: [], env: {}, ...partial };
}

function input(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "th1",
    turnId: "t1",
    cwd: process.cwd(),
    prompt: "do it",
    model: "auto",
    runtimeMode: "full",
    resumeSessionId: null,
    resumeAt: null,
    interactionMode: "default",
    requestUserInput: async () => null,
    handoffContext: null,
    signal: new AbortController().signal,
    requestApproval: async () => "allow",
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cursor honours provider settings", () => {
  it("runs the configured binary with extra args before the prompt and the user env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wooky-cursor-settings-"));
    dirs.push(dir);
    const argvFile = join(dir, "argv.json");
    const adapter = createCursorAdapter({
      cursorArgsPrefix: [CURSOR_FAKE_AGENT_SCRIPT],
      settings: () =>
        settings({
          binaryPath: process.execPath,
          extraArgs: ["--sandbox", "enabled"],
          // The fake agent writes its argv to this file, which proves env reached the child.
          env: { WOOKY_FAKE_CURSOR_LOG_ARGV: argvFile },
        }),
    });
    const events = await collect(adapter.runTurn(input({ prompt: "hello there" })));
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const argv: string[] = JSON.parse(await readFile(argvFile, "utf8"));
    expect(argv.slice(-3)).toEqual([
      "--sandbox",
      "enabled",
      expect.stringContaining("hello there"),
    ]);
  });

  it("fails the turn with the problem when the binary path is invalid", async () => {
    const adapter = createCursorAdapter({
      settings: () => settings({ binaryPath: "not/absolute" }),
    });
    const events = await collect(adapter.runTurn(input()));
    expect(events).toEqual([
      { type: "done", status: "failed", error: expect.stringMatching(/must be absolute/) },
    ]);
  });
});

describe("codex honours provider settings", () => {
  it("fails the turn with the problem when the binary path is invalid", async () => {
    const adapter = createCodexAdapter({
      settings: () => settings({ binaryPath: "not/absolute" }),
    });
    const events = await collect(adapter.runTurn(input()));
    expect(events).toEqual([
      { type: "done", status: "failed", error: expect.stringMatching(/must be absolute/) },
    ]);
  });
});

describe("claude honours provider settings", () => {
  type Params = Parameters<typeof query>[0];

  function recording() {
    const calls: Params[] = [];
    const fake = ((params: Params) => {
      calls.push(params);
      const gen = (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "s",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })();
      return Object.assign(gen, { close: vi.fn<() => void>() });
    }) as unknown as typeof query;
    return { fake, calls };
  }

  it("passes the binary path, SDK extra args and merged env to the SDK", async () => {
    const { fake, calls } = recording();
    const adapter = createClaudeAdapter({
      query: fake,
      settings: () =>
        settings({
          binaryPath: process.execPath,
          extraArgs: ["--max-turns", "3", "-x"],
          env: { WOOKY_TEST_ENV_VALUE: "yes" },
        }),
    });
    await collect(adapter.runTurn(input({ model: "default" })));
    const options = calls[0]?.options as Options;
    expect(options.pathToClaudeCodeExecutable).toBe(process.execPath);
    expect(options.extraArgs).toEqual({ "max-turns": "3" });
    expect(options.env?.WOOKY_TEST_ENV_VALUE).toBe("yes");
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it("leaves the options alone with no settings", async () => {
    const { fake, calls } = recording();
    await collect(createClaudeAdapter({ query: fake }).runTurn(input({ model: "default" })));
    const options = calls[0]?.options as Options;
    expect(options).not.toHaveProperty("extraArgs");
    expect(options).not.toHaveProperty("env");
  });

  it("fails the turn without starting the SDK when the binary path is invalid", async () => {
    const { fake, calls } = recording();
    const adapter = createClaudeAdapter({
      query: fake,
      settings: () => settings({ binaryPath: "not/absolute" }),
    });
    const events = await collect(adapter.runTurn(input({ model: "default" })));
    expect(calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "done", status: "failed", error: expect.stringMatching(/must be absolute/) },
    ]);
  });
});
