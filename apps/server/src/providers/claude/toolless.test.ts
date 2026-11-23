import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_INTERNAL_ENV_KEYS, setAgentRuntime } from "../agent-env.ts";
import type { TurnInput } from "../types.ts";
import { createClaudeAdapter } from "./adapter.ts";
import { assistant, init, resultSuccess, sentPrompt, text, type SDKMessage } from "./fixtures.ts";

function fakeQuery() {
  const calls: Array<Parameters<typeof query>[0]> = [];
  const fake = ((params: Parameters<typeof query>[0]) => {
    calls.push(params);
    async function* script(): AsyncGenerator<SDKMessage> {
      yield init();
      yield assistant("m1", [text("{}")]);
      yield resultSuccess();
    }
    return Object.assign(script(), { close: () => undefined });
  }) as unknown as typeof query;
  return { fake, calls };
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "brain-extract-1",
    turnId: "brain-extract-1",
    cwd: "/work",
    prompt: "extract",
    model: "haiku",
    runtimeMode: "approve",
    resumeSessionId: null,
    resumeAt: null,
    interactionMode: "default",
    requestUserInput: async () => null,
    handoffContext: null,
    signal: new AbortController().signal,
    requestApproval: async () => "allow",
    toolless: true,
    ...overrides,
  };
}

async function drain(iterable: AsyncIterable<unknown>) {
  for await (const event of iterable) void event;
}

describe("claude toolless turn", () => {
  afterEach(() => {
    setAgentRuntime(null);
  });

  it("declares that it can guarantee no tools", () => {
    expect(createClaudeAdapter().supportsToolless).toBe(true);
  });

  it("starts the CLI with no tools, no settings, no MCP, no persistence and nothing pre-approved", async () => {
    const { fake, calls } = fakeQuery();
    await drain(createClaudeAdapter({ query: fake }).runTurn(turn()));
    const options = calls[0]?.options as Options;
    expect(options).toMatchObject({
      tools: [],
      allowedTools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      permissionMode: "dontAsk",
    });
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options).not.toHaveProperty("resume");
    expect(options).not.toHaveProperty("extraArgs");
    expect(options).not.toHaveProperty("settings");
    expect(options.permissionMode).not.toBe("bypassPermissions");
    expect((await sentPrompt(calls[0]?.prompt)).text).toBe("extract");
  });

  it("denies anything that still asks, whatever the runtime mode", async () => {
    const { fake, calls } = fakeQuery();
    await drain(createClaudeAdapter({ query: fake }).runTurn(turn({ runtimeMode: "full" })));
    const options = calls[0]?.options as Options;
    expect(options.permissionMode).toBe("dontAsk");
    const verdict = await options.canUseTool?.("Bash", { command: "echo hi" }, {
      signal: new AbortController().signal,
      toolUseID: "tu1",
    } as never);
    expect(verdict).toMatchObject({ behavior: "deny" });
  });

  it("carries no fleet environment, shim, token or coordinator instructions", async () => {
    setAgentRuntime({
      serverUrl: "http://127.0.0.1:4317",
      wookyBin: "/tmp/wooky-home/bin/wooky",
      issueToken: () => "secret-token",
    });
    const previous = Object.fromEntries(AGENT_INTERNAL_ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.WOOKY_SERVER_URL = "http://leak";
    process.env.WOOKY_AGENT_TOKEN = "leaked-token";
    process.env.WOOKY_THREAD_ID = "leaked-thread";
    try {
      const { fake, calls } = fakeQuery();
      const adapter = createClaudeAdapter({
        query: fake,
        settings: () => ({
          customModels: [],
          extraArgs: ["--dangerously-skip-permissions"],
          env: { MY_KEY: "kept" },
        }),
      });
      await drain(adapter.runTurn(turn()));
      const options = calls[0]?.options as Options;
      for (const key of AGENT_INTERNAL_ENV_KEYS) expect(options.env).not.toHaveProperty(key);
      expect(options.env?.PATH).not.toContain("wooky-home");
      expect(options.env?.MY_KEY).toBe("kept");
      expect(JSON.stringify(options.systemPrompt ?? "")).not.toMatch(/wooky agents/);
      expect(options).not.toHaveProperty("extraArgs");
    } finally {
      for (const key of AGENT_INTERNAL_ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it("leaves an ordinary turn alone", async () => {
    const { fake, calls } = fakeQuery();
    await drain(createClaudeAdapter({ query: fake }).runTurn(turn({ toolless: undefined })));
    const options = calls[0]?.options as Options;
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("settingSources");
    expect(options).not.toHaveProperty("persistSession");
  });
});
