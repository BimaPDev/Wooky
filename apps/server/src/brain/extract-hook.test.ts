import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReadModel } from "@wooky/domain";
import type { DeviceSettings, ProviderEvent, ReadModel, Thread, Turn } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import type { ProviderAdapter, TurnInput } from "../providers/types.ts";
import type { CompleteFn, ExtractDeps, ExtractInput } from "./extract.ts";
import {
  createExtractor,
  createFinishHook,
  inputForFinishedTurn,
  isTrivialTurn,
} from "./extract-hook.ts";
import { createProviderComplete, extractionModel } from "./extract-model.ts";

const candidate = JSON.stringify({
  candidates: [
    {
      scope: "project",
      path: "decisions/use-pnpm.md",
      kind: "decision",
      summary: "Use pnpm, never npm",
      body: "Lockfile is pnpm-lock.yaml",
      tags: [],
    },
  ],
});

const input = (extra: Partial<ExtractInput> = {}): ExtractInput => ({
  projectId: "p1",
  threadId: "t1",
  turnId: "u1",
  agent: "claude",
  prompt: "Switch the repo from npm to pnpm and fix the CI cache step so builds are fast again.",
  finalMessage:
    "Done. The lockfile is pnpm-lock.yaml now, CI restores the pnpm store, and the old package-lock.json is deleted so nobody runs npm by mistake.",
  changedFiles: ["package.json"],
  outcome: "completed",
  ...extra,
});

interface Rig {
  writes: string[];
  logs: string[];
  complete: ReturnType<typeof vi.fn<CompleteFn>>;
  extractor: ReturnType<typeof createExtractor>;
}

function rig(options: {
  complete?: CompleteFn;
  settings?: { extractProject: boolean; extractGlobal: boolean };
  timeoutMs?: number;
  projectBrain?: (id: string) => boolean;
}): Rig {
  const writes: string[] = [];
  const logs: string[] = [];
  const complete = vi.fn<CompleteFn>(options.complete ?? (async () => candidate));
  const brain: ExtractDeps["brain"] = {
    list: () => [],
    read: () => {
      throw new ServiceError("not_found", "none");
    },
    write: (uri) => {
      writes.push(uri);
      return { uri, updatedAt: "t", created: true };
    },
  };
  const extractor = createExtractor({
    deps: { complete, brain, submitGlobalProposal: () => {} },
    settings: () => options.settings ?? { extractProject: true, extractGlobal: true },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.projectBrain ? { projectBrain: options.projectBrain } : {}),
    log: (message) => logs.push(message),
  });
  return { writes, logs, complete, extractor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("extractor guards", () => {
  it("writes a project memory in the background", async () => {
    const r = rig({});
    r.extractor.onTurnFinished(input());
    expect(r.complete).not.toHaveBeenCalled();
    await r.extractor.idle();
    expect(r.writes).toEqual(["brain://project/p1/decisions/use-pnpm.md"]);
  });

  it("does nothing when both switches are off", async () => {
    const r = rig({ settings: { extractProject: false, extractGlobal: false } });
    r.extractor.onTurnFinished(input());
    await r.extractor.idle();
    expect(r.complete).not.toHaveBeenCalled();
  });

  it("skips a project without its own repo but still allows global proposals", async () => {
    const r = rig({ projectBrain: () => false });
    r.extractor.onTurnFinished(input());
    await r.extractor.idle();
    expect(r.complete).toHaveBeenCalledTimes(1);
    expect(r.writes).toEqual([]);
  });

  it("skips trivial, failed and cancelled turns", async () => {
    const r = rig({});
    r.extractor.onTurnFinished(input({ prompt: "hi", finalMessage: "hello" }));
    r.extractor.onTurnFinished(input({ outcome: "failed" }));
    r.extractor.onTurnFinished(input({ outcome: "interrupted" }));
    r.extractor.onTurnFinished(input({ finalMessage: "ok", changedFiles: [] }));
    await r.extractor.idle();
    expect(r.complete).not.toHaveBeenCalled();
    expect(isTrivialTurn(input())).toBe(false);
  });

  it("runs one extraction per thread at a time and lets other threads run", async () => {
    const release: (() => void)[] = [];
    const r = rig({
      complete: () =>
        new Promise<string>((resolve) => {
          release.push(() => resolve(candidate));
        }),
    });
    r.extractor.onTurnFinished(input());
    r.extractor.onTurnFinished(input({ turnId: "u2" }));
    r.extractor.onTurnFinished(input({ threadId: "t2" }));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(2));
    for (const done of release) done();
    await r.extractor.idle();
    r.extractor.onTurnFinished(input({ turnId: "u3" }));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(3));
    release.at(-1)?.();
    await r.extractor.idle();
  });

  it("never propagates a model error", async () => {
    const r = rig({
      complete: async () => {
        throw new Error("boom");
      },
    });
    expect(() => r.extractor.onTurnFinished(input())).not.toThrow();
    await expect(r.extractor.idle()).resolves.toBeUndefined();
    expect(r.logs.join("\n")).toContain("boom");
    r.extractor.onTurnFinished(input({ turnId: "u2" }));
    await r.extractor.idle();
    expect(r.complete).toHaveBeenCalledTimes(2);
  });

  it("times out a model that never answers and aborts its signal", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const r = rig({
      timeoutMs: 1000,
      complete: (_prompt, { signal }) => {
        seen = signal;
        return new Promise<string>(() => {});
      },
    });
    r.extractor.onTurnFinished(input());
    await vi.advanceTimersByTimeAsync(1001);
    await r.extractor.idle();
    expect(seen?.aborted).toBe(true);
    expect(r.logs.join("\n")).toContain("timed out");
    expect(r.writes).toEqual([]);
  });

  it("stop aborts a running extraction and ignores later finishes", async () => {
    let seen: AbortSignal | undefined;
    const r = rig({
      complete: (_prompt, { signal }) => {
        seen = signal;
        return new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    r.extractor.onTurnFinished(input());
    await vi.waitFor(() => expect(seen).toBeDefined());
    r.extractor.stop();
    await r.extractor.idle();
    expect(seen?.aborted).toBe(true);
    r.extractor.onTurnFinished(input({ threadId: "t9" }));
    await r.extractor.idle();
    expect(r.complete).toHaveBeenCalledTimes(1);
  });
});

const baseThread = (extra: Partial<Thread>): Thread => ({
  id: "t1",
  projectId: "p1",
  title: "Thread",
  provider: "claude",
  model: "sonnet",
  runtimeMode: "approve",
  worktree: null,
  providerSessionId: null,
  ownerDeviceId: null,
  movedTo: null,
  movedFrom: null,
  pullRequest: null,
  queue: [],
  status: "idle",
  createdAt: "2026-11-23T10:00:00.000Z",
  updatedAt: "2026-11-23T10:00:00.000Z",
  ...extra,
});

const baseTurn = (threadId: string, extra: Partial<Turn> = {}): Turn => ({
  id: `${threadId}-u1`,
  threadId,
  prompt: "Do the big refactor across the service and keep the tests green please.",
  provider: "claude",
  model: "sonnet",
  status: "completed",
  items: [{ kind: "message", id: "m1", role: "assistant", text: "All done; the refactor landed." }],
  startedAt: "2026-11-23T10:00:00.000Z",
  endedAt: "2026-11-23T10:01:00.000Z",
  checkpointBefore: null,
  checkpointAfter: null,
  changedFiles: ["src/a.ts"],
  usage: null,
  error: null,
  ...extra,
});

function modelWith(threads: Thread[], turns: Record<string, Turn[]>): ReadModel {
  const model = emptyReadModel();
  for (const thread of threads) model.threads[thread.id] = thread;
  Object.assign(model.turns, turns);
  return model;
}

describe("inputForFinishedTurn", () => {
  it("builds a turn input for a solo thread", () => {
    const model = modelWith([baseThread({})], { t1: [baseTurn("t1")] });
    const found = inputForFinishedTurn(model, "t1", "t1-u1");
    expect(found?.kind).toBe("turn");
    expect(found?.input).toMatchObject({
      projectId: "p1",
      threadId: "t1",
      turnId: "t1-u1",
      agent: "claude",
      finalMessage: "All done; the refactor landed.",
      changedFiles: ["src/a.ts"],
      outcome: "completed",
    });
  });

  it("yields nothing for a worker, a demo thread or a running turn", () => {
    const worker = modelWith([baseThread({ role: "worker", parentThreadId: "c" })], {
      t1: [baseTurn("t1")],
    });
    expect(inputForFinishedTurn(worker, "t1", "t1-u1")).toBeNull();
    const demo = modelWith([baseThread({ provider: "demo" })], { t1: [baseTurn("t1")] });
    expect(inputForFinishedTurn(demo, "t1", "t1-u1")).toBeNull();
    const running = modelWith([baseThread({})], { t1: [baseTurn("t1", { status: "running" })] });
    expect(inputForFinishedTurn(running, "t1", "t1-u1")).toBeNull();
  });

  it("makes one fleet-run input when the coordinator finishes after its workers", () => {
    const model = modelWith(
      [
        baseThread({ role: "coordinator" }),
        baseThread({
          id: "w1",
          role: "worker",
          parentThreadId: "t1",
          title: "Worker one",
          report: { turnId: "w1-u1", summary: "Split the module.", at: "2026-11-23T10:00:30.000Z" },
        }),
      ],
      { t1: [baseTurn("t1")], w1: [baseTurn("w1", { changedFiles: ["src/b.ts"] })] },
    );
    const found = inputForFinishedTurn(model, "t1", "t1-u1");
    expect(found?.kind).toBe("fleet");
    expect(found?.input).toMatchObject({
      fleetRunId: "t1",
      changedFiles: ["src/a.ts", "src/b.ts"],
      workerReports: [{ title: "Worker one", summary: "Split the module." }],
    });
  });

  it("waits while a worker still runs or the coordinator has queued follow-ups", () => {
    const running = modelWith(
      [
        baseThread({ role: "coordinator" }),
        baseThread({ id: "w1", role: "worker", parentThreadId: "t1", status: "running" }),
      ],
      { t1: [baseTurn("t1")], w1: [baseTurn("w1", { status: "running" })] },
    );
    expect(inputForFinishedTurn(running, "t1", "t1-u1")).toBeNull();
    const queued = modelWith(
      [
        baseThread({
          role: "coordinator",
          queue: [{ id: "q1", prompt: "report", queuedAt: "2026-11-23T10:02:00.000Z" }],
        }),
        baseThread({ id: "w1", role: "worker", parentThreadId: "t1" }),
      ],
      { t1: [baseTurn("t1")], w1: [baseTurn("w1")] },
    );
    expect(inputForFinishedTurn(queued, "t1", "t1-u1")).toBeNull();
  });
});

describe("createFinishHook", () => {
  const extractor = () => ({
    onTurnFinished: vi.fn<(input: ExtractInput) => void>(),
    onFleetRunFinished: vi.fn<(input: ExtractInput) => void>(),
    idle: async () => {},
    stop: () => {},
  });

  it("routes turns and fleet runs and swallows errors", () => {
    const solo = extractor();
    const model = modelWith([baseThread({})], { t1: [baseTurn("t1")] });
    createFinishHook({ extractor: solo, model: () => model })({ threadId: "t1", turnId: "t1-u1" });
    expect(solo.onTurnFinished).toHaveBeenCalledTimes(1);

    const broken = extractor();
    const logs: string[] = [];
    const hook = createFinishHook({
      extractor: broken,
      model: () => {
        throw new Error("model gone");
      },
      log: (message) => logs.push(message),
    });
    expect(() => hook({ threadId: "t1", turnId: "t1-u1" })).not.toThrow();
    expect(logs.join("")).toContain("model gone");
  });
});

describe("createProviderComplete", () => {
  const settings = (patch: Partial<DeviceSettings["brain"]> = {}, disabled: string[] = []) =>
    ({
      disabledProviders: disabled,
      brain: { extractProject: true, extractGlobal: true, ...patch },
    }) as unknown as DeviceSettings;

  function adapter(events: ProviderEvent[], seen: TurnInput[] = []): ProviderAdapter {
    return {
      kind: "claude",
      probe: async () => {
        throw new Error("not used");
      },
      async *runTurn(turn) {
        seen.push(turn);
        for (const event of events) yield event;
      },
    };
  }
  const msg = (id: string, text: string): ProviderEvent => ({
    type: "item",
    item: { kind: "message", id, role: "assistant", text },
  });
  const done: ProviderEvent = { type: "done", status: "completed", error: null };
  const signal = new AbortController().signal;

  let home: string;
  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    home = mkdtempSync(join(tmpdir(), "wooky-extract-model-"));
  });
  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(home, { recursive: true, force: true });
  });

  it("runs one denied, session-less turn on the cheap model and returns the last message", async () => {
    const seen: TurnInput[] = [];
    const complete = createProviderComplete({
      providers: {
        get: () =>
          adapter(
            [msg("a", "first"), msg("b", ""), { type: "delta", itemId: "b", text: "{}" }, done],
            seen,
          ),
      },
      settings: () => settings(),
      home,
    });
    await expect(complete("prompt", { signal })).resolves.toBe("{}");
    expect(seen[0]).toMatchObject({
      model: "haiku",
      runtimeMode: "approve",
      resumeSessionId: null,
      handoffContext: null,
      prompt: "prompt",
    });
    await expect(
      seen[0]?.requestApproval({ requestId: "r", tool: "command", title: "x", detail: "y" }),
    ).resolves.toBe("deny");
    await expect(
      seen[0]?.requestUserInput({
        requestId: "r",
        questions: [{ id: "q", question: "?", options: [], multiSelect: false, allowCustom: true }],
      }),
    ).resolves.toBeNull();
    expect(seen[0]?.cwd.startsWith(home)).toBe(true);
  });

  it("fails on a failed turn, a missing adapter and a disabled provider", async () => {
    const failed = createProviderComplete({
      providers: { get: () => adapter([{ type: "done", status: "failed", error: "x" }]) },
      settings: () => settings(),
      home,
    });
    await expect(failed("p", { signal })).rejects.toThrow(/failed/);
    const missing = createProviderComplete({
      providers: { get: () => null },
      settings: () => settings(),
      home,
    });
    await expect(missing("p", { signal })).rejects.toThrow(/not installed/);
    const disabled = createProviderComplete({
      providers: { get: () => adapter([msg("a", "x"), done]) },
      settings: () => settings({}, ["claude"]),
      home,
    });
    await expect(disabled("p", { signal })).rejects.toThrow(/No model/);
  });

  it("prefers the model the user chose", () => {
    expect(
      extractionModel(settings({ extractModel: { provider: "codex", model: "mini" } })),
    ).toEqual({ provider: "codex", model: "mini" });
  });
});
