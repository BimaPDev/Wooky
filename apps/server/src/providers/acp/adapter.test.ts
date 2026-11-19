import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceSettings, type ApprovalRequest, type ProviderEvent } from "@wooky/contracts";
import { setAgentRuntime } from "../agent-env.ts";
import { builtinAdapters } from "../index.ts";
import { createProviderRegistry } from "../registry.ts";
import { createOpenCodeAdapter, resetOpenCodeModelsCache } from "../opencode/adapter.ts";
import type { TurnInput } from "../types.ts";
import { ACP_FAKE_AGENT_SCRIPT, createAcpAdapter } from "./adapter.ts";
import { SILENT_AGENT_NOTICE } from "./turn.ts";
// @ts-expect-error test fixture is plain ESM without types
import { FAKE_ACP_VERSION } from "./fixtures/fake-acp-agent.mjs";

const ENV_KEYS = [
  "AGE_FAKE_ACP_SCENARIO",
  "AGE_FAKE_ACP_LOG",
  "AGE_FAKE_ACP_ENV_FILE",
  "AGE_FAKE_ACP_TOOL_KIND",
  "AGE_FAKE_ACP_AUTH",
  "AGE_TEST_ENV_MARKER",
] as const;

async function collect(gen: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function doneOf(events: ProviderEvent[]) {
  const done = events.filter((event) => event.type === "done");
  expect(done).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("done");
  return done[0];
}

function baseInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: process.cwd(),
    prompt: "Create a file hello.txt containing hi",
    model: "gem",
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

function settings(
  overrides: {
    extraArgs?: string[];
    env?: Record<string, string>;
    agentEnv?: Record<string, string>;
    models?: string[];
    enabled?: boolean;
    model?: string;
  } = {},
) {
  return () =>
    DeviceSettings.parse({
      providers: {
        acp: {
          ...(overrides.extraArgs ? { extraArgs: overrides.extraArgs } : {}),
          ...(overrides.env ? { env: overrides.env } : {}),
        },
      },
      acpAgents: [
        {
          id: "gem",
          name: "Gem",
          command: process.execPath,
          args: [ACP_FAKE_AGENT_SCRIPT],
          enabled: overrides.enabled ?? true,
          ...(overrides.agentEnv ? { env: overrides.agentEnv } : {}),
          ...(overrides.models ? { models: overrides.models } : {}),
        },
      ],
    });
}

async function readLog(file: string) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

describe("ACP adapter", () => {
  let home = "";

  afterEach(async () => {
    setAgentRuntime(null);
    for (const key of ENV_KEYS) delete process.env[key];
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  async function tempDir() {
    home = await mkdtemp(join(tmpdir(), "age-acp-"));
    return home;
  }

  it("streams a prompt into message, reasoning, plan, and usage events", async () => {
    const events = await collect(createAcpAdapter({ settings: settings() }).runTurn(baseInput()));
    const done = doneOf(events);
    expect(done).toMatchObject({ status: "completed", error: null });
    expect(
      events.some((event) => event.type === "session" && event.sessionId === "sess_fake_1"),
    ).toBe(true);
    const message = events.find((event) => event.type === "item" && event.item.kind === "message");
    const delta = events.find((event) => event.type === "delta");
    expect(message).toMatchObject({ item: { text: "Hello " } });
    expect(delta).toMatchObject({ text: "world" });
    expect(events.some((event) => event.type === "item" && event.item.kind === "reasoning")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "plan")).toBe(true);
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });

  it("warns once when an agent never asks, and stays quiet when it does", async () => {
    const quiet = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(baseInput({ runtimeMode: "approve" })),
    );
    const notices = quiet.filter((event) => event.type === "item" && event.item.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ item: { text: SILENT_AGENT_NOTICE } });
    expect(quiet.at(-1)?.type).toBe("done");

    const full = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(baseInput({ runtimeMode: "full" })),
    );
    expect(full.some((event) => event.type === "item" && event.item.kind === "notice")).toBe(false);

    process.env.AGE_FAKE_ACP_SCENARIO = "permission";
    const asked = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(baseInput({ runtimeMode: "approve" })),
    );
    expect(asked.some((event) => event.type === "item" && event.item.kind === "notice")).toBe(
      false,
    );
  });

  it("approves and denies a tool permission", async () => {
    process.env.AGE_FAKE_ACP_SCENARIO = "permission";
    const dir = await tempDir();
    const log = join(dir, "log");
    process.env.AGE_FAKE_ACP_LOG = log;
    const approvals: ApprovalRequest[] = [];
    const allowed = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({
          runtimeMode: "approve",
          requestApproval: async (request) => {
            approvals.push(request);
            return "allow";
          },
        }),
      ),
    );
    expect(doneOf(allowed)?.status).toBe("completed");
    expect(approvals.map((request) => request.tool)).toEqual(["command"]);
    const allowLog = await readLog(log);
    expect(allowLog.some((entry) => entry.method === "permission-result")).toBe(true);
    expect(JSON.stringify(allowLog)).toContain('"optionId":"allow"');

    approvals.length = 0;
    const denied = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({
          runtimeMode: "approve",
          requestApproval: async (request) => {
            approvals.push(request);
            return "deny";
          },
        }),
      ),
    );
    expect(doneOf(denied)?.status).toBe("completed");
    const tool = denied.findLast((event) => event.type === "item" && event.item.kind === "tool");
    expect(tool).toMatchObject({ item: { status: "failed" } });
  });

  it("skips the card in full mode and for edits in auto-edits", async () => {
    process.env.AGE_FAKE_ACP_SCENARIO = "permission";
    const asked: string[] = [];
    const full = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({
          runtimeMode: "full",
          requestApproval: async () => {
            asked.push("full");
            return "deny";
          },
        }),
      ),
    );
    expect(doneOf(full)?.status).toBe("completed");
    expect(asked).toEqual([]);

    process.env.AGE_FAKE_ACP_TOOL_KIND = "edit";
    const edits = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({
          runtimeMode: "auto-edits",
          requestApproval: async () => {
            asked.push("edit");
            return "deny";
          },
        }),
      ),
    );
    expect(doneOf(edits)?.status).toBe("completed");
    expect(asked).toEqual([]);

    delete process.env.AGE_FAKE_ACP_TOOL_KIND;
    const command = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({
          runtimeMode: "auto-edits",
          requestApproval: async () => {
            asked.push("command");
            return "allow";
          },
        }),
      ),
    );
    expect(doneOf(command)?.status).toBe("completed");
    expect(asked).toEqual(["command"]);

    const planned = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({
          runtimeMode: "full",
          interactionMode: "plan",
          requestApproval: async () => {
            asked.push("plan");
            return "deny";
          },
        }),
      ),
    );
    expect(doneOf(planned)?.status).toBe("completed");
    expect(asked).toContain("plan");
  });

  it("cancels the session and kills a hung agent", async () => {
    process.env.AGE_FAKE_ACP_SCENARIO = "cancel";
    const dir = await tempDir();
    const log = join(dir, "cancel-log");
    process.env.AGE_FAKE_ACP_LOG = log;
    const controller = new AbortController();
    const events: ProviderEvent[] = [];
    for await (const event of createAcpAdapter({ settings: settings() }).runTurn(
      baseInput({ signal: controller.signal }),
    )) {
      events.push(event);
      if (event.type === "item") controller.abort();
    }
    expect(doneOf(events)).toMatchObject({ status: "interrupted", error: null });
    const entries = await readLog(log);
    expect(entries.some((entry) => entry.method === "session/cancel")).toBe(true);

    process.env.AGE_FAKE_ACP_SCENARIO = "hang";
    const hungController = new AbortController();
    const hung: ProviderEvent[] = [];
    for await (const event of createAcpAdapter({ settings: settings(), killGraceMs: 40 }).runTurn(
      baseInput({ signal: hungController.signal }),
    )) {
      hung.push(event);
      if (event.type === "item") hungController.abort();
    }
    expect(doneOf(hung)).toMatchObject({ status: "interrupted" });
  });

  it("classifies a rate-limit error and a crash", async () => {
    process.env.AGE_FAKE_ACP_SCENARIO = "rate-limit";
    const limited = await collect(createAcpAdapter({ settings: settings() }).runTurn(baseInput()));
    expect(doneOf(limited)).toMatchObject({
      status: "failed",
      failure: { kind: "rate_limit" },
    });

    process.env.AGE_FAKE_ACP_SCENARIO = "crash";
    const crashed = await collect(createAcpAdapter({ settings: settings() }).runTurn(baseInput()));
    const crash = doneOf(crashed);
    expect(crash).toMatchObject({ status: "failed" });
    expect(crash && "error" in crash ? crash.error : "").toContain("simulated crash");
    expect(crash).not.toHaveProperty("failure");
  });

  it("continues after a malformed line and an oversized line", async () => {
    const notes: string[] = [];
    process.env.AGE_FAKE_ACP_SCENARIO = "malformed";
    const events = await collect(
      createAcpAdapter({ settings: settings(), onDebug: (message) => notes.push(message) }).runTurn(
        baseInput(),
      ),
    );
    expect(doneOf(events)?.status).toBe("completed");
    expect(notes.some((note) => note.includes("invalid message"))).toBe(true);
    expect(notes.some((note) => note.includes("mystery/note"))).toBe(true);
    expect(notes.some((note) => note.includes("future_widget"))).toBe(true);

    notes.length = 0;
    process.env.AGE_FAKE_ACP_SCENARIO = "oversize";
    const oversized = await collect(
      createAcpAdapter({
        settings: settings(),
        maxLineBytes: 4_000,
        onDebug: (message) => notes.push(message),
      }).runTurn(baseInput()),
    );
    expect(doneOf(oversized)?.status).toBe("completed");
    expect(notes.some((note) => note.includes("oversized"))).toBe(true);
  });

  it("resumes with session/load and otherwise sends the handoff transcript", async () => {
    const dir = await tempDir();
    const log = join(dir, "load");
    process.env.AGE_FAKE_ACP_LOG = log;
    const resumed = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({ resumeSessionId: "sess_old", handoffContext: "prior talk" }),
      ),
    );
    expect(doneOf(resumed)?.status).toBe("completed");
    const loaded = await readLog(log);
    expect(loaded.some((entry) => entry.method === "session/load")).toBe(true);
    expect(loaded.some((entry) => entry.method === "session/new")).toBe(false);
    const prompt = loaded.find((entry) => entry.method === "session/prompt");
    expect(JSON.stringify(prompt?.params)).not.toContain("prior talk");
    expect(JSON.stringify(prompt?.params)).not.toContain("age agents guide");

    process.env.AGE_FAKE_ACP_SCENARIO = "no-load";
    const handed = await collect(
      createAcpAdapter({ settings: settings() }).runTurn(
        baseInput({ resumeSessionId: "sess_old", handoffContext: "prior talk" }),
      ),
    );
    expect(doneOf(handed)?.status).toBe("completed");
    expect(handed.some((event) => event.type === "session")).toBe(false);
    const again = await readLog(log);
    const nextPrompt = again.filter((entry) => entry.method === "session/prompt").at(-1);
    expect(JSON.stringify(nextPrompt?.params)).toContain("prior talk");
    expect(JSON.stringify(nextPrompt?.params)).toContain("age agents guide");
  });

  it("merges env without logging it and injects the fleet variables", async () => {
    const dir = await tempDir();
    const envFile = join(dir, "env.json");
    const log = join(dir, "argv");
    process.env.AGE_FAKE_ACP_ENV_FILE = envFile;
    process.env.AGE_FAKE_ACP_LOG = log;
    setAgentRuntime({ serverUrl: "http://127.0.0.1:9", ageBin: join(dir, "age") });
    const events = await collect(
      createAcpAdapter({
        settings: settings({
          agentEnv: { AGE_TEST_ENV_MARKER: "from-agent", AGE_THREAD_ID: "nope" },
          env: { AGE_TEST_ENV_MARKER: "from-provider" },
          extraArgs: ["--extra"],
        }),
      }).runTurn(baseInput()),
    );
    expect(doneOf(events)?.status).toBe("completed");
    const captured = JSON.parse(await readFile(envFile, "utf8")) as {
      AGE_THREAD_ID: string;
      MARKER: string;
    };
    expect(captured.AGE_THREAD_ID).toBe("thread-1");
    expect(captured.MARKER).toBe("from-provider");
    const entries = await readLog(log);
    expect(entries.find((entry) => entry.method === "argv")?.params).toEqual(["--extra"]);
    expect(JSON.stringify(entries)).not.toContain("from-provider");
  });

  it("probes each enabled agent and lists both providers", async () => {
    process.env.AGE_FAKE_ACP_AUTH = "1";
    const authed = await createAcpAdapter({
      settings: settings({ models: ["gemini-2.5-pro"] }),
    }).probe();
    expect(authed).toMatchObject({
      installed: true,
      authenticated: null,
      version: `Fake ACP ${FAKE_ACP_VERSION}`,
      modelsSource: "custom",
    });
    expect(authed.models).toEqual([
      { id: "gem/gemini-2.5-pro", label: "Gem/gemini-2.5-pro", modelsSource: "custom" },
    ]);

    delete process.env.AGE_FAKE_ACP_AUTH;
    const open = await createAcpAdapter({ settings: settings() }).probe();
    expect(open.authenticated).toBe(true);
    expect(open.models).toEqual([{ id: "gem", label: "Gem", modelsSource: "custom" }]);

    const missing = await createAcpAdapter({
      settings: () =>
        DeviceSettings.parse({
          acpAgents: [
            {
              id: "gem",
              name: "Gem",
              command: "age-missing-acp-bin",
              enabled: true,
            },
          ],
        }),
    }).probe();
    expect(missing.installed).toBe(false);
    expect(missing.problem).toContain("Gem");

    const none = await createAcpAdapter({
      settings: () => DeviceSettings.parse({}),
    }).probe();
    expect(none).toMatchObject({ installed: false, problem: "No ACP agents are enabled." });

    resetOpenCodeModelsCache();
    const registry = createProviderRegistry([
      createAcpAdapter({ settings: settings() }),
      createOpenCodeAdapter({
        bin: process.execPath,
        argsPrefix: [ACP_FAKE_AGENT_SCRIPT],
        settings: () =>
          DeviceSettings.parse({ providers: { opencode: { customModels: ["local/one"] } } }),
      }),
    ]);
    const listed = await registry.list();
    expect(listed.map((status) => status.kind).sort()).toEqual(["acp", "opencode"]);
    const opencode = listed.find((status) => status.kind === "opencode");
    expect(opencode?.models.map((model) => model.id)).toEqual([
      "opencode/big-pickle",
      "opencode/deepseek-v4.1-flash-free",
      "local/one",
    ]);
    expect(opencode?.modelsSource).toBe("live");
    expect(builtinAdapters().map((adapter) => adapter.kind)).toEqual([
      "claude",
      "codex",
      "cursor",
      "demo",
      "opencode",
      "acp",
    ]);
  });
});
