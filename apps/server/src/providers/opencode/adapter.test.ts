import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceSettings, type ProviderEvent } from "@age/contracts";
import { ACP_FAKE_AGENT_SCRIPT } from "../acp/adapter.ts";
import type { TurnInput } from "../types.ts";
import { createOpenCodeAdapter, resetOpenCodeModelsCache } from "./adapter.ts";

async function collect(gen: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: process.cwd(),
    prompt: "Create a file hello.txt containing hi",
    model: "opencode/big-pickle",
    runtimeMode: "full",
    resumeSessionId: null,
    resumeAt: null,
    interactionMode: "default",
    handoffContext: null,
    signal: new AbortController().signal,
    requestApproval: async () => "allow",
    requestUserInput: async () => null,
    ...overrides,
  };
}

describe("OpenCode adapter", () => {
  let home = "";

  afterEach(async () => {
    resetOpenCodeModelsCache();
    delete process.env.AGE_FAKE_ACP_LOG;
    delete process.env.AGE_FAKE_ACP_SCENARIO;
    delete process.env.AGE_FAKE_ACP_ENV_FILE;
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  it("selects the model with session/set_config_option and appends extra args", async () => {
    home = await mkdtemp(join(tmpdir(), "age-opencode-"));
    const log = join(home, "log");
    process.env.AGE_FAKE_ACP_LOG = log;
    const adapter = createOpenCodeAdapter({
      bin: process.execPath,
      argsPrefix: [ACP_FAKE_AGENT_SCRIPT],
      settings: () =>
        DeviceSettings.parse({
          providers: {
            opencode: { extraArgs: ["--pure"], env: { AGE_TEST_ENV_MARKER: "secret" } },
          },
        }),
    });
    const events = await collect(adapter.runTurn(turn()));
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const text = await readFile(log, "utf8");
    expect(text).not.toContain("secret");
    const entries = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { method: string; params: unknown });
    expect(entries.find((entry) => entry.method === "argv")?.params).toEqual(["acp", "--pure"]);
    expect(entries.some((entry) => entry.method === "session/set_config_option")).toBe(true);
    expect(text).toContain("opencode/big-pickle");
  });

  it("sets OPENCODE_PERMISSION from the runtime mode over a settings value", async () => {
    home = await mkdtemp(join(tmpdir(), "age-opencode-perm-"));
    const envFile = join(home, "env.json");
    process.env.AGE_FAKE_ACP_ENV_FILE = envFile;
    const adapter = createOpenCodeAdapter({
      bin: process.execPath,
      argsPrefix: [ACP_FAKE_AGENT_SCRIPT],
      settings: () =>
        DeviceSettings.parse({
          providers: { opencode: { env: { OPENCODE_PERMISSION: '{"edit":"allow"}' } } },
        }),
    });
    const events = await collect(adapter.runTurn(turn({ runtimeMode: "approve" })));
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const captured = JSON.parse(await readFile(envFile, "utf8")) as { OPENCODE_PERMISSION: string };
    expect(JSON.parse(captured.OPENCODE_PERMISSION)).toEqual({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
    });
    expect(events.some((event) => event.type === "item" && event.item.kind === "notice")).toBe(
      false,
    );
  });

  it("reports a missing binary without spawning a shell", async () => {
    const status = await createOpenCodeAdapter({
      bin: "age-missing-opencode",
      settings: () =>
        DeviceSettings.parse({ providers: { opencode: { customModels: ["local/one"] } } }),
    }).probe();
    expect(status).toMatchObject({
      installed: false,
      problem: "OpenCode is not installed.",
      models: [{ id: "local/one", label: "local/one", modelsSource: "custom" }],
    });
  });
});
