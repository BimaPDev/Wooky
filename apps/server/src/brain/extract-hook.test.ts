import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReadModel } from "@wooky/domain";
import type { DeviceSettings, ProviderEvent, ReadModel, Thread, Turn } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import type { ProviderAdapter, TurnInput } from "../providers/types.ts";
import type { CompleteFn, ExtractDeps, ExtractInput } from "./extract.ts";
import {
  EXTRACT_COOLDOWN_MS,
  EXTRACT_QUEUE_MAX,
  createExtractor,
  createFinishHook,
  inputForFinishedTurn,
  isTrivialTurn,
} from "./extract-hook.ts";
import {
  createProviderComplete,
  extractionModel,
  extractionModelProblem,
} from "./extract-model.ts";

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
  lists: string[];
  clock: { now: number };
  complete: ReturnType<typeof vi.fn<CompleteFn>>;
  extractor: ReturnType<typeof createExtractor>;
}

function rig(options: {
  complete?: CompleteFn;
  settings?: { extractProject: boolean; extractGlobal: boolean };
  timeoutMs?: number;
  projectBrain?: (id: string) => boolean;
  unavailable?: () => string | null;
  cooldownMs?: number;
  queueMax?: number;
}): Rig {
  const writes: string[] = [];
  const logs: string[] = [];
  const lists: string[] = [];
  const clock = { now: 1_000_000 };
  const complete = vi.fn<CompleteFn>(options.complete ?? (async () => candidate));
  const brain: ExtractDeps["brain"] = {
    list: (dir) => {
      lists.push(dir);
      return [];
    },
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
    ...(options.unavailable ? { unavailable: options.unavailable } : {}),
    ...(options.queueMax === undefined ? {} : { queueMax: options.queueMax }),
    cooldownMs: options.cooldownMs ?? 0,
    now: () => clock.now,
    log: (message) => logs.push(message),
  });
  return { writes, logs, lists, clock, complete, extractor };
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

  it("runs one extraction per thread at a time", async () => {
    const release: (() => void)[] = [];
    const r = rig({
      complete: () =>
        new Promise<string>((resolve) => {
          release.push(() => resolve(candidate));
        }),
    });
    r.extractor.onTurnFinished(input());
    r.extractor.onTurnFinished(input({ turnId: "u2" }));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(1));
    release[0]?.();
    await r.extractor.idle();
    expect(r.complete).toHaveBeenCalledTimes(1);
    r.extractor.onTurnFinished(input({ turnId: "u3" }));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(2));
    release[1]?.();
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

describe("extractor cost and cadence", () => {
  const onProject = (n: number, extra: Partial<ExtractInput> = {}) =>
    input({ threadId: `t${n}`, projectId: `p${n}`, ...extra });

  it("runs one extraction at a time across all threads", async () => {
    let active = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const r = rig({
      complete: () =>
        new Promise<string>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          release.push(() => {
            active -= 1;
            resolve(candidate);
          });
        }),
    });
    r.extractor.onTurnFinished(onProject(1));
    r.extractor.onTurnFinished(onProject(2));
    r.extractor.onTurnFinished(onProject(3));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(1));
    release[0]?.();
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(2));
    release[1]?.();
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(3));
    release[2]?.();
    await r.extractor.idle();
    expect(peak).toBe(1);
    expect(r.writes).toHaveLength(3);
  });

  it("keeps a small queue and drops the oldest waiting job beyond it", async () => {
    expect(EXTRACT_QUEUE_MAX).toBeGreaterThan(0);
    const release: (() => void)[] = [];
    const r = rig({
      queueMax: 2,
      complete: () =>
        new Promise<string>((resolve) => {
          release.push(() => resolve(candidate));
        }),
    });
    for (const n of [1, 2, 3, 4]) r.extractor.onTurnFinished(onProject(n));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(1));
    expect(r.logs.join("\n")).toMatch(/dropped the oldest/);
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(release[index]).toBeDefined());
      release[index]?.();
    }
    await r.extractor.idle();
    expect(r.writes.map((uri) => uri.split("/")[3])).toEqual(["p1", "p3", "p4"]);
  });

  it("waits out a per-project cooldown, and other projects are not held by it", async () => {
    expect(EXTRACT_COOLDOWN_MS).toBe(60_000);
    const r = rig({ cooldownMs: EXTRACT_COOLDOWN_MS });
    r.extractor.onTurnFinished(input({ threadId: "t1" }));
    await r.extractor.idle();
    r.clock.now += 30_000;
    r.extractor.onTurnFinished(input({ threadId: "t2" }));
    r.extractor.onTurnFinished(input({ threadId: "t3", projectId: "p2" }));
    await r.extractor.idle();
    expect(r.writes.map((uri) => uri.split("/")[3])).toEqual(["p1", "p2"]);
    r.clock.now += 31_000;
    r.extractor.onTurnFinished(input({ threadId: "t4" }));
    await r.extractor.idle();
    expect(r.writes.map((uri) => uri.split("/")[3])).toEqual(["p1", "p2", "p1"]);
  });

  it("checks for a usable model before scanning any brain and logs the skip once", async () => {
    let reason: string | null = "provider codex cannot run a tool-free turn";
    const r = rig({ unavailable: () => reason });
    r.extractor.onTurnFinished(input());
    r.extractor.onTurnFinished(input({ turnId: "u2" }));
    r.extractor.onFleetRunFinished(input({ threadId: "t2" }));
    await r.extractor.idle();
    expect(r.complete).not.toHaveBeenCalled();
    expect(r.lists).toEqual([]);
    expect(
      r.logs.filter((line) => line.includes("codex cannot run a tool-free turn")),
    ).toHaveLength(1);
    reason = null;
    r.extractor.onTurnFinished(input({ turnId: "u3" }));
    await r.extractor.idle();
    expect(r.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps a thread's slot until its work settles after a timeout, but frees the line", async () => {
    vi.useFakeTimers();
    const finish: (() => void)[] = [];
    const r = rig({
      timeoutMs: 1000,
      complete: () =>
        new Promise<string>((resolve) => {
          finish.push(() => resolve(candidate));
        }),
    });
    r.extractor.onTurnFinished(onProject(1));
    await vi.advanceTimersByTimeAsync(1001);
    expect(r.logs.join("\n")).toContain("timed out");
    let idled = false;
    void r.extractor.idle().then(() => {
      idled = true;
    });
    r.extractor.onTurnFinished(onProject(1, { turnId: "u2" }));
    r.extractor.onTurnFinished(onProject(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.complete).toHaveBeenCalledTimes(2);
    expect(idled).toBe(false);
    finish[0]?.();
    finish[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    await r.extractor.idle();
    expect(idled).toBe(true);
    expect(r.writes).toEqual(["brain://project/p2/decisions/use-pnpm.md"]);
    r.extractor.onTurnFinished(onProject(1, { turnId: "u3" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.complete).toHaveBeenCalledTimes(3);
    finish[2]?.();
    await r.extractor.idle();
  });

  it("drain stops, waits briefly, and says whether the work settled", async () => {
    vi.useFakeTimers();
    const stuck = rig({ complete: () => new Promise<string>(() => {}) });
    stuck.extractor.onTurnFinished(input());
    await vi.advanceTimersByTimeAsync(0);
    const drained = stuck.extractor.drain(500);
    await vi.advanceTimersByTimeAsync(501);
    await expect(drained).resolves.toBe(false);

    const polite = rig({
      complete: (_prompt, { signal }) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    polite.extractor.onTurnFinished(input());
    await vi.advanceTimersByTimeAsync(0);
    await expect(polite.extractor.drain(500)).resolves.toBe(true);
    polite.extractor.onTurnFinished(input({ threadId: "t2", projectId: "p2" }));
    expect(polite.complete).toHaveBeenCalledTimes(1);
  });

  it("never starts queued work after stop", async () => {
    const release: (() => void)[] = [];
    const r = rig({
      complete: () =>
        new Promise<string>((resolve) => {
          release.push(() => resolve(candidate));
        }),
    });
    r.extractor.onTurnFinished(onProject(1));
    r.extractor.onTurnFinished(onProject(2));
    await vi.waitFor(() => expect(r.complete).toHaveBeenCalledTimes(1));
    r.extractor.stop();
    release[0]?.();
    await r.extractor.idle();
    expect(r.complete).toHaveBeenCalledTimes(1);
    expect(r.writes).toEqual([]);
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

  const fleet = (reports: Record<string, string>) =>
    modelWith(
      [
        baseThread({ role: "coordinator" }),
        ...Object.entries(reports).map(([id, turnId]) =>
          baseThread({
            id,
            role: "worker",
            parentThreadId: "t1",
            title: `Worker ${id}`,
            report: { turnId, summary: `Report of ${id}`, at: "2026-11-23T10:00:30.000Z" },
          }),
        ),
      ],
      {
        t1: [baseTurn("t1")],
        ...Object.fromEntries(
          Object.keys(reports).map((id) => [
            id,
            [baseTurn(id, { changedFiles: [`src/${id}.ts`] })],
          ]),
        ),
      },
    );

  it("passes only worker reports not yet extracted, with their files", () => {
    const model = fleet({ w1: "w1-u1", w2: "w2-u1" });
    const found = inputForFinishedTurn(model, "t1", "t1-u1", new Set(["w1:w1-u1"]));
    expect(found?.kind).toBe("fleet");
    expect(found?.input.workerReports?.map((report) => report.title)).toEqual(["Worker w2"]);
    expect(found?.input.changedFiles).toEqual(["src/a.ts", "src/w2.ts"]);
    expect(found?.reportKeys).toEqual(["w2:w2-u1"]);
  });

  it("falls back to a plain turn when every report was already extracted", () => {
    const model = fleet({ w1: "w1-u1" });
    const found = inputForFinishedTurn(model, "t1", "t1-u1", new Set(["w1:w1-u1"]));
    expect(found?.kind).toBe("turn");
    expect(found?.input.workerReports).toBeUndefined();
    expect(found?.reportKeys).toEqual([]);
  });
});

describe("createFinishHook", () => {
  const extractor = () => ({
    onTurnFinished: vi.fn<(input: ExtractInput) => void>(),
    onFleetRunFinished: vi.fn<(input: ExtractInput) => void>(),
    idle: async () => {},
    drain: async () => true,
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

  it("extracts a fleet run once, then only reports it has not seen", () => {
    const worker = (turnId: string) =>
      baseThread({
        id: "w1",
        role: "worker",
        parentThreadId: "t1",
        title: "Worker one",
        report: { turnId, summary: `Report ${turnId}`, at: "2026-11-23T10:00:30.000Z" },
      });
    let model = modelWith([baseThread({ role: "coordinator" }), worker("w1-u1")], {
      t1: [baseTurn("t1")],
      w1: [baseTurn("w1")],
    });
    const sink = extractor();
    const hook = createFinishHook({ extractor: sink, model: () => model });

    hook({ threadId: "t1", turnId: "t1-u1" });
    hook({ threadId: "t1", turnId: "t1-u1" });
    expect(sink.onFleetRunFinished).toHaveBeenCalledTimes(1);
    expect(sink.onTurnFinished).not.toHaveBeenCalled();
    expect(sink.onFleetRunFinished.mock.calls[0]?.[0].workerReports).toHaveLength(1);

    model = modelWith([baseThread({ role: "coordinator" }), worker("w1-u1")], {
      t1: [baseTurn("t1"), baseTurn("t1", { id: "t1-u2" })],
      w1: [baseTurn("w1")],
    });
    hook({ threadId: "t1", turnId: "t1-u2" });
    expect(sink.onFleetRunFinished).toHaveBeenCalledTimes(1);
    expect(sink.onTurnFinished).toHaveBeenCalledTimes(1);
    expect(sink.onTurnFinished.mock.calls[0]?.[0].workerReports).toBeUndefined();

    model = modelWith([baseThread({ role: "coordinator" }), worker("w1-u2")], {
      t1: [baseTurn("t1"), baseTurn("t1", { id: "t1-u2" }), baseTurn("t1", { id: "t1-u3" })],
      w1: [baseTurn("w1")],
    });
    hook({ threadId: "t1", turnId: "t1-u3" });
    expect(sink.onFleetRunFinished).toHaveBeenCalledTimes(2);
    expect(sink.onFleetRunFinished.mock.calls[1]?.[0].workerReports).toEqual([
      { title: "Worker one", status: "done", summary: "Report w1-u2" },
    ]);
  });
});

describe("createProviderComplete", () => {
  const settings = (patch: Partial<DeviceSettings["brain"]> = {}, disabled: string[] = []) =>
    ({
      disabledProviders: disabled,
      brain: { extractProject: true, extractGlobal: true, ...patch },
    }) as unknown as DeviceSettings;

  function adapter(
    events: ProviderEvent[],
    seen: TurnInput[] = [],
    supportsToolless = true,
  ): ProviderAdapter {
    return {
      kind: "claude",
      ...(supportsToolless ? { supportsToolless: true } : {}),
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
      toolless: true,
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

  it("prefers the model the user chose, among providers that can run without tools", () => {
    expect(
      extractionModel(settings({ extractModel: { provider: "claude", model: "sonnet" } })),
    ).toEqual({ provider: "claude", model: "sonnet" });
  });

  it("fails closed for a provider that cannot guarantee no tools", async () => {
    for (const provider of ["codex", "cursor", "opencode", "acp", "demo"] as const) {
      const chosen = settings({ extractModel: { provider, model: "m" } });
      expect([provider, extractionModel(chosen)]).toEqual([provider, null]);
      expect(extractionModelProblem(chosen)).toMatch(new RegExp(`${provider}.*tool`, "i"));
    }
    const seen: TurnInput[] = [];
    const refused = createProviderComplete({
      providers: { get: () => adapter([msg("a", "x"), done], seen) },
      settings: () => settings({ extractModel: { provider: "codex", model: "mini" } }),
      home,
    });
    await expect(refused("p", { signal })).rejects.toThrow(/codex.*tool/i);
    expect(seen).toEqual([]);
  });

  it("refuses an adapter that does not declare it honours the toolless flag", async () => {
    const seen: TurnInput[] = [];
    const complete = createProviderComplete({
      providers: { get: () => adapter([msg("a", "{}"), done], seen, false) },
      settings: () => settings(),
      home,
    });
    await expect(complete("p", { signal })).rejects.toThrow(/tool/i);
    expect(seen).toEqual([]);
  });

  it("is usable by default only through Claude, and not when Claude is disabled", () => {
    expect(extractionModel(settings())).toEqual({ provider: "claude", model: "haiku" });
    expect(extractionModelProblem(settings())).toBeNull();
    expect(extractionModel(settings({}, ["claude"]))).toBeNull();
    expect(extractionModelProblem(settings({}, ["claude"]))).toMatch(/claude/i);
  });
});
