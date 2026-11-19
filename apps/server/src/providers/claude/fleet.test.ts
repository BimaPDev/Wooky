import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coordinatorInstructions, setAgentRuntime, workerNote } from "../agent-env.ts";
import type { TurnInput } from "../types.ts";
import { createClaudeAdapter } from "./adapter.ts";
import { assistant, init, resultSuccess, text, type SDKMessage } from "./fixtures.ts";

function fakeQuery() {
  const calls: Array<Parameters<typeof query>[0]> = [];
  const fake = ((params: Parameters<typeof query>[0]) => {
    calls.push(params);
    async function* script(): AsyncGenerator<SDKMessage> {
      yield init();
      yield assistant("m1", [text("hi")]);
      yield resultSuccess();
    }
    return Object.assign(script(), { close: () => undefined });
  }) as unknown as typeof query;
  return { fake, calls };
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "th1",
    turnId: "t1",
    cwd: "/work",
    prompt: "do it",
    model: "default",
    runtimeMode: "approve",
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

async function drain(iterable: AsyncIterable<unknown>) {
  for await (const event of iterable) void event;
}

describe("claude fleet env", () => {
  afterEach(() => {
    setAgentRuntime(null);
  });

  it("appends coordinator instructions and the age environment", async () => {
    setAgentRuntime({ serverUrl: "http://127.0.0.1:4317", ageBin: "/tmp/age-home/bin/age" });
    const { fake, calls } = fakeQuery();
    const adapter = createClaudeAdapter({ query: fake });
    await drain(adapter.runTurn(turn()));
    await drain(adapter.runTurn(turn({ resumeSessionId: "sess-9" })));
    for (const call of calls) {
      const options = call.options as Options;
      expect(options.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: coordinatorInstructions(),
      });
      expect(options.env?.AGE_THREAD_ID).toBe("th1");
      expect(options.env?.AGE_SERVER_URL).toBe("http://127.0.0.1:4317");
      expect(options.env?.PATH?.startsWith(`/tmp/age-home/bin${delimiter}`)).toBe(true);
    }
    expect(calls[0]?.prompt).toBe("do it");
  });

  it("appends the one-line worker note", async () => {
    setAgentRuntime({ serverUrl: "http://127.0.0.1:4317", ageBin: "/tmp/age-home/bin/age" });
    const { fake, calls } = fakeQuery();
    await drain(createClaudeAdapter({ query: fake }).runTurn(turn({ role: "worker" })));
    const options = calls[0]?.options;
    if (!options) throw new Error("expected a query");
    expect((options as Options).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: workerNote(),
    });
  });
});
