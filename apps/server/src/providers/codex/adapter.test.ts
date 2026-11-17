import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalRequest, ProviderEvent, ProviderStatus } from "@age/contracts";
import type { TurnInput } from "../types.ts";
import { createCodexAdapter } from "./adapter.ts";

const fakeServerPath = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits (polling the event loop, no sleep) until the given pid no longer exists. */
async function waitForPidToExit(pid: number): Promise<void> {
  while (isPidAlive(pid)) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

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

describe("createCodexAdapter", () => {
  let workDir = "";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "age-codex-test-"));
  });

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  function baseInput(overrides?: Partial<TurnInput>): TurnInput {
    return {
      threadId: "t_1",
      turnId: "u_1",
      cwd: workDir,
      prompt: "Run the test suite",
      model: "gpt-6.1-sol",
      runtimeMode: "approve",
      resumeSessionId: null,
      handoffContext: null,
      signal: new AbortController().signal,
      requestApproval: async () => "allow",
      ...overrides,
    };
  }

  it("probe reports installed false and the expected problem when codexBin does not exist", async () => {
    const adapter = createCodexAdapter({
      codexBin: join(workDir, "definitely-missing-codex-binary"),
    });
    const status = await adapter.probe();
    ProviderStatus.parse(status);

    expect(status.kind).toBe("codex");
    expect(status.installed).toBe(false);
    expect(status.authenticated).toBeNull();
    expect(status.version).toBeNull();
    expect(status.problem).toBe(
      "Codex CLI was not found on PATH. Install it and sign in, then refresh.",
    );
    expect(status.models.some((m) => m.id === "default")).toBe(true);
    expect(status.models.length).toBeGreaterThan(1);
  });

  it("probe extracts version when codexBin responds to --version", async () => {
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath],
    });
    const status = await adapter.probe();
    ProviderStatus.parse(status);

    expect(status.installed).toBe(true);
    expect(status.authenticated).toBeNull();
    expect(status.version).toBe("0.160.0");
    expect(status.problem).toBeNull();
  });

  it("runs a full turn on the allow approval path and emits one terminal done event", async () => {
    const logFile = join(workDir, "allow.jsonl");
    const approvals: ApprovalRequest[] = [];
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--log-file", logFile],
    });

    const events = await collectEvents(
      adapter.runTurn(
        baseInput({
          handoffContext: "User: hello\n\nAssistant: hi",
          requestApproval: async (req) => {
            approvals.push(req);
            return "allow";
          },
        }),
      ),
    );

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      tool: "command",
      title: "pnpm test",
      detail: "Run project test suite",
    });

    expect(events[0]).toEqual({ type: "session", sessionId: "thr_started_1" });
    expect(
      events.some(
        (ev) =>
          ev.type === "item" &&
          ev.item.kind === "tool" &&
          ev.item.tool === "command" &&
          ev.item.status === "done" &&
          ev.item.output === "all checks green\n",
      ),
    ).toBe(true);
    expect(
      events.some(
        (ev) =>
          ev.type === "item" &&
          ev.item.kind === "message" &&
          ev.item.text === "Done running checks.",
      ),
    ).toBe(true);
    expect(events.some((ev) => ev.type === "usage" && ev.usage.inputTokens === 100)).toBe(true);

    const doneEvents = events.filter((ev) => ev.type === "done");
    expect(doneEvents).toEqual([{ type: "done", status: "completed", error: null }]);
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });

    const frames = readLoggedFrames(logFile);
    expect(frames.map((f) => f.method).filter(Boolean)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(frames[1]).toEqual({ method: "initialized" });

    const threadStart = frames.find((f) => f.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      cwd: workDir,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      model: "gpt-6.1-sol",
    });

    const turnStart = frames.find((f) => f.method === "turn/start");
    const turnParams = turnStart?.params as {
      input: Array<{ type: string; text: string }>;
      sandboxPolicy: Record<string, unknown>;
    };
    expect(
      turnParams.input[0]?.text.startsWith(
        "Earlier conversation in this thread, from another agent:",
      ),
    ).toBe(true);
    expect(turnParams.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });

    const approvalReply = frames.find((f) => f.id === 500 && !("method" in f));
    expect(approvalReply?.result).toEqual({ decision: "accept" });
  });

  it("replies decline on the deny approval path and marks the declined command tool failed", async () => {
    const logFile = join(workDir, "deny.jsonl");
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--log-file", logFile],
    });

    const events = await collectEvents(
      adapter.runTurn(
        baseInput({
          requestApproval: async () => "deny",
        }),
      ),
    );

    const approvalReply = readLoggedFrames(logFile).find((f) => f.id === 500 && !("method" in f));
    expect(approvalReply?.result).toEqual({ decision: "decline" });

    expect(
      events.some(
        (ev) =>
          ev.type === "item" &&
          ev.item.kind === "tool" &&
          ev.item.id === "cmd_1" &&
          ev.item.status === "failed",
      ),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });
  });

  it("forwards diff preview for fileChange approvals in approve mode and auto-accepts in auto-edits mode", async () => {
    const approveCards: ApprovalRequest[] = [];
    const approveAdapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--scenario", "file-approval"],
    });

    await collectEvents(
      approveAdapter.runTurn(
        baseInput({
          runtimeMode: "approve",
          requestApproval: async (req) => {
            approveCards.push(req);
            return "allow";
          },
        }),
      ),
    );

    expect(approveCards).toHaveLength(1);
    expect(approveCards[0]).toMatchObject({
      tool: "edit",
      title: "Edit src/app.ts",
      detail: "Update src/app.ts",
    });
    expect(approveCards[0]?.diff).toContain("+const newVal = 2;");

    const autoEditSpy = vi.fn<TurnInput["requestApproval"]>(async () => "allow");
    const logFile = join(workDir, "auto-edits.jsonl");
    const autoEditsAdapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--scenario", "file-approval", "--log-file", logFile],
    });

    const autoEvents = await collectEvents(
      autoEditsAdapter.runTurn(
        baseInput({
          runtimeMode: "auto-edits",
          requestApproval: autoEditSpy,
        }),
      ),
    );

    expect(autoEditSpy).not.toHaveBeenCalled();
    expect(autoEvents.at(-1)).toEqual({ type: "done", status: "completed", error: null });

    const threadStart = readLoggedFrames(logFile).find((f) => f.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
  });

  it("never calls requestApproval in full mode and sends never + danger-full-access", async () => {
    const logFile = join(workDir, "full.jsonl");
    const requestApproval = vi.fn<TurnInput["requestApproval"]>(async () => "deny");
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--scenario", "force-approval", "--log-file", logFile],
    });

    const events = await collectEvents(
      adapter.runTurn(
        baseInput({
          runtimeMode: "full",
          model: "default",
          requestApproval,
        }),
      ),
    );

    expect(requestApproval).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });

    const frames = readLoggedFrames(logFile);
    const threadStart = frames.find((f) => f.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(threadStart?.params).not.toHaveProperty("model");

    const turnStart = frames.find((f) => f.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("uses thread/resume instead of thread/start when resumeSessionId is provided", async () => {
    const logFile = join(workDir, "resume.jsonl");
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--log-file", logFile],
    });

    const events = await collectEvents(
      adapter.runTurn(
        baseInput({
          runtimeMode: "full",
          resumeSessionId: "thr_existing_42",
        }),
      ),
    );

    expect(events[0]).toEqual({ type: "session", sessionId: "thr_existing_42" });
    expect(events.at(-1)).toEqual({ type: "done", status: "completed", error: null });

    const frames = readLoggedFrames(logFile);
    expect(frames.some((f) => f.method === "thread/start")).toBe(false);
    const resumeCall = frames.find((f) => f.method === "thread/resume");
    expect(resumeCall?.params).toMatchObject({
      threadId: "thr_existing_42",
      cwd: workDir,
    });
  });

  it("aborts mid-turn, sends turn/interrupt, terminates the spawned PID, and emits done interrupted", async () => {
    const logFile = join(workDir, "abort.jsonl");
    const pidFile = join(workDir, "abort.pid");
    const controller = new AbortController();
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [
        fakeServerPath,
        "--scenario",
        "hang-mid-turn",
        "--log-file",
        logFile,
        "--pid-file",
        pidFile,
      ],
    });

    const received: ProviderEvent[] = [];
    for await (const event of adapter.runTurn(baseInput({ signal: controller.signal }))) {
      ProviderEvent.parse(event);
      received.push(event);
      if (event.type === "item" && event.item.kind === "reasoning" && event.item.text.length > 0) {
        controller.abort();
      }
    }

    const spawnedPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(spawnedPid)).toBe(true);
    expect(isPidAlive(spawnedPid)).toBe(false);

    const doneEvents = received.filter((ev) => ev.type === "done");
    expect(doneEvents).toEqual([{ type: "done", status: "interrupted", error: null }]);
    expect(received.at(-1)).toEqual({ type: "done", status: "interrupted", error: null });

    const frames = readLoggedFrames(logFile);
    const interruptFrame = frames.find((f) => f.method === "turn/interrupt");
    expect(interruptFrame?.params).toEqual({
      threadId: "thr_started_1",
      turnId: "turn_fake_1",
    });
  });

  it("answers a pending approval with exactly one decline when the turn is interrupted mid-approval", async () => {
    const logFile = join(workDir, "abort-approval.jsonl");
    const controller = new AbortController();
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--log-file", logFile],
    });

    let approvalCount = 0;
    const received: ProviderEvent[] = [];
    for await (const event of adapter.runTurn(
      baseInput({
        signal: controller.signal,
        // Interrupt while the approval is still pending; never resolve it ourselves.
        requestApproval: () => {
          approvalCount += 1;
          controller.abort();
          return new Promise<"allow" | "deny">(() => {});
        },
      }),
    )) {
      ProviderEvent.parse(event);
      received.push(event);
    }

    expect(approvalCount).toBe(1);

    const doneEvents = received.filter((ev) => ev.type === "done");
    expect(doneEvents).toEqual([{ type: "done", status: "interrupted", error: null }]);
    expect(received.at(-1)).toEqual({ type: "done", status: "interrupted", error: null });

    const approvalReplies = readLoggedFrames(logFile).filter(
      (f) => f.id === 500 && !("method" in f),
    );
    expect(approvalReplies).toHaveLength(1);
    expect(approvalReplies[0]?.result).toEqual({ decision: "decline" });
  });

  it("reports per-turn token usage as the delta over the prior turn's cumulative total", async () => {
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--scenario", "cumulative-usage"],
    });

    const firstEvents = await collectEvents(
      adapter.runTurn(baseInput({ runtimeMode: "full", resumeSessionId: null })),
    );
    expect(firstEvents[0]).toEqual({ type: "session", sessionId: "thr_started_1" });
    const firstUsage = firstEvents.find((ev) => ev.type === "usage");
    if (firstUsage?.type !== "usage") throw new Error("expected a usage event in turn 1");
    expect(firstUsage.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });

    const secondEvents = await collectEvents(
      adapter.runTurn(baseInput({ runtimeMode: "full", resumeSessionId: "thr_started_1" })),
    );
    const secondUsage = secondEvents.find((ev) => ev.type === "usage");
    if (secondUsage?.type !== "usage") throw new Error("expected a usage event in turn 2");
    // Cumulative totals: turn 1 = 100/50, turn 2 = 250/120 -> turn 2 delta = 150/70.
    expect(secondUsage.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 70,
      cachedInputTokens: 15,
    });
  });

  it("kills the whole process group so a grandchild does not outlive stop", async () => {
    const gcPidFile = join(workDir, "grandchild.pid");
    const controller = new AbortController();
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [
        fakeServerPath,
        "--scenario",
        "spawn-grandchild",
        "--grandchild-pid-file",
        gcPidFile,
      ],
    });

    for await (const event of adapter.runTurn(baseInput({ signal: controller.signal }))) {
      ProviderEvent.parse(event);
      if (event.type === "item" && event.item.kind === "reasoning" && event.item.text.length > 0) {
        controller.abort();
      }
    }

    const gcPid = Number(readFileSync(gcPidFile, "utf8").trim());
    expect(Number.isInteger(gcPid)).toBe(true);
    await waitForPidToExit(gcPid);
    expect(isPidAlive(gcPid)).toBe(false);
  });

  it("emits done failed with the last 4 KB stderr tail when the app-server crashes mid-turn", async () => {
    const adapter = createCodexAdapter({
      codexBin: process.execPath,
      codexArgs: [fakeServerPath, "--scenario", "crash-mid-turn"],
    });

    const events = await collectEvents(adapter.runTurn(baseInput()));
    const doneEvents = events.filter((ev) => ev.type === "done");
    expect(doneEvents).toHaveLength(1);

    const last = events.at(-1);
    if (last?.type !== "done") {
      throw new Error("Expected final event to be done");
    }
    expect(last.status).toBe("failed");
    expect(last.error).toContain("FATAL: simulated codex panic in worker");
    expect(Buffer.byteLength(last.error ?? "", "utf8")).toBeLessThanOrEqual(4200);
  });
});
