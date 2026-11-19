import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderEvent } from "@wooky/contracts";
import { coordinatorInstructions, setAgentRuntime, workerNote } from "../agent-env.ts";
import type { TurnInput } from "../types.ts";
import { createCursorAdapter } from "./adapter.ts";

const SCRIPT = `import { writeFileSync } from "node:fs";
const file = process.env.AGE_FLEET_CAPTURE;
if (file) {
  writeFileSync(file, JSON.stringify({
    AGE_THREAD_ID: process.env.AGE_THREAD_ID ?? null,
    AGE_SERVER_URL: process.env.AGE_SERVER_URL ?? null,
    PATH: process.env.PATH ?? "",
    argv: process.argv.slice(2),
  }));
}
process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"ok"}\\n', () => {
  process.exit(0);
});
`;

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: process.cwd(),
    prompt: "test prompt",
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

async function collect(gen: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("cursor fleet env", () => {
  let home = "";
  const previous = process.env.AGE_FLEET_CAPTURE;

  afterEach(async () => {
    setAgentRuntime(null);
    if (previous === undefined) delete process.env.AGE_FLEET_CAPTURE;
    else process.env.AGE_FLEET_CAPTURE = previous;
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  async function run(input: TurnInput) {
    if (home) await rm(home, { recursive: true, force: true });
    home = await mkdtemp(join(tmpdir(), "age-cursor-fleet-"));
    const script = join(home, "fake-agent.mjs");
    const capture = join(home, "capture.json");
    await writeFile(script, SCRIPT, "utf8");
    process.env.AGE_FLEET_CAPTURE = capture;
    setAgentRuntime({
      serverUrl: "http://127.0.0.1:4317",
      ageBin: join(home, "bin", "age"),
    });
    const adapter = createCursorAdapter({
      cursorBin: process.execPath,
      cursorArgsPrefix: [script],
    });
    const events = await collect(adapter.runTurn(input));
    const done = events.filter((event) => event.type === "done").at(-1);
    expect(done?.status).toBe("completed");
    return JSON.parse(await readFile(capture, "utf8")) as {
      AGE_THREAD_ID: string | null;
      AGE_SERVER_URL: string | null;
      PATH: string;
      argv: string[];
    };
  }

  it("passes the age environment and prefixes the first prompt", async () => {
    const captured = await run(turn());
    expect(captured.AGE_THREAD_ID).toBe("thread-1");
    expect(captured.AGE_SERVER_URL).toBe("http://127.0.0.1:4317");
    expect(captured.PATH.startsWith(`${join(home, "bin")}${delimiter}`)).toBe(true);
    expect(captured.argv.at(-1)).toBe(`${coordinatorInstructions()}\n\ntest prompt`);

    const resumed = await run(turn({ resumeSessionId: "sess-prev" }));
    expect(resumed.argv.at(-1)).toBe("test prompt");
  });

  it("prefixes the worker note and not the coordinator instructions", async () => {
    const captured = await run(turn({ role: "worker" }));
    expect(captured.argv.at(-1)).toBe(`${workerNote()}\n\ntest prompt`);
    expect(captured.argv.at(-1)).not.toContain("age agents spawn");
  });
});
