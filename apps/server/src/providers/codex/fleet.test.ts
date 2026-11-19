import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderEvent } from "@wooky/contracts";
import { coordinatorInstructions, setAgentRuntime, workerNote } from "../agent-env.ts";
import type { TurnInput } from "../types.ts";
import { createCodexAdapter } from "./adapter.ts";

const fakeServerPath = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

function readLoggedFrames(logPath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function collectEvents(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) {
    ProviderEvent.parse(event);
    out.push(event);
  }
  return out;
}

describe("codex fleet env", () => {
  let home = "";
  const previous = process.env.AGE_FAKE_CODEX_LOG_ENV;

  afterEach(() => {
    setAgentRuntime(null);
    if (previous === undefined) delete process.env.AGE_FAKE_CODEX_LOG_ENV;
    else process.env.AGE_FAKE_CODEX_LOG_ENV = previous;
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  function turn(overrides: Partial<TurnInput> = {}): TurnInput {
    return {
      threadId: "t_1",
      turnId: "u_1",
      cwd: home,
      prompt: "Run the test suite",
      model: "gpt-6.1-sol",
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

  async function run(overrides: Partial<TurnInput> = {}) {
    if (home) rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(tmpdir(), "age-codex-fleet-"));
    const logFile = join(home, "frames.jsonl");
    const envFile = join(home, "env.json");
    process.env.AGE_FAKE_CODEX_LOG_ENV = envFile;
    setAgentRuntime({
      serverUrl: "http://127.0.0.1:4317",
      ageBin: join(home, "bin", "age"),
    });
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--log-file", logFile],
    });
    const events = await collectEvents(adapter.runTurn(turn(overrides)));
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const frames = readLoggedFrames(logFile);
    const turnStart = frames.find((frame) => frame.method === "turn/start");
    const params = turnStart?.params as { input: Array<{ text: string }> };
    const env = JSON.parse(readFileSync(envFile, "utf8")) as {
      AGE_THREAD_ID: string | null;
      AGE_SERVER_URL: string | null;
      PATH: string;
    };
    return { text: params.input[0]?.text ?? "", env };
  }

  it("passes the age environment and prefixes the first prompt", async () => {
    const first = await run();
    expect(first.env.AGE_THREAD_ID).toBe("t_1");
    expect(first.env.AGE_SERVER_URL).toBe("http://127.0.0.1:4317");
    expect(first.env.PATH.startsWith(`${join(home, "bin")}${delimiter}`)).toBe(true);
    expect(first.text).toBe(`${coordinatorInstructions()}\n\nRun the test suite`);

    const resumed = await run({ resumeSessionId: "thr_started_1" });
    expect(resumed.text).toBe("Run the test suite");
  });

  it("prefixes the worker note and not the coordinator instructions", async () => {
    const captured = await run({ role: "worker" });
    expect(captured.text).toBe(`${workerNote()}\n\nRun the test suite`);
    expect(captured.text).not.toContain("age agents spawn");
  });
});
