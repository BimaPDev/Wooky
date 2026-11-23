import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceSettings,
  FailoverSettings,
  type AgeEvent,
  type Command,
  type ProviderEvent,
  type ProviderKind,
  type RuntimeMode,
  type Thread,
  type TurnFailure,
} from "@wooky/contracts";
import type { BrainTurnHooks } from "../brain/context.ts";
import { createNoopGitService } from "../git/noop.ts";
import type { GitService } from "../git/types.ts";
import type { DecideContext } from "../orchestrator/decide.ts";
import { createDispatcher } from "../orchestrator/dispatcher.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import type { ProviderAdapter, TurnInput } from "../providers/types.ts";
import { openEventStore, type EventStore } from "../store/event-store.ts";
import { childrenOf } from "@wooky/domain";
import { createFakeGit, tempDir, testContext, waitForEvent } from "../testing.ts";
import { createEffectRunner, type EffectRunner } from "./runner.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function scripted(
  kind: ProviderKind,
  run: (input: TurnInput) => AsyncIterable<ProviderEvent>,
  models: { id: string; label: string }[] = [
    { id: kind === "claude" ? "sonnet" : kind, label: kind },
  ],
): ProviderAdapter {
  return {
    kind,
    probe: async () => ({
      kind,
      label: kind,
      installed: true,
      authenticated: true,
      version: null,
      models,
      problem: null,
    }),
    runTurn: run,
  };
}

async function harness(
  options: {
    adapters?: ProviderAdapter[];
    git?: GitService;
    wrapStore?: (store: EventStore) => EventStore;
    capabilities?: DecideContext["capabilities"];
    deviceSettings?: DeviceSettings;
    brain?: BrainTurnHooks;
  } = {},
) {
  const home = await tempDir("runner");
  const root = await tempDir("project");
  const settings = options.deviceSettings ?? DeviceSettings.parse({});
  const ctx = testContext(options.capabilities, settings.failover);
  ctx.hasProvider = (kind) =>
    (options.adapters ?? [createDemoAdapter({ stepMs: 0 })]).some((a) => a.kind === kind);
  const fake = createFakeGit();
  const opened = openEventStore(home, ctx.now);
  const store = options.wrapStore?.(opened) ?? opened;
  const providers = createProviderRegistry(options.adapters ?? [createDemoAdapter({ stepMs: 0 })]);
  let send: (command: Command) => void = () => {};
  const runner = createEffectRunner({
    store,
    providers,
    git: options.git ?? fake.git,
    newId: ctx.newId,
    dispatch: (command) => send(command),
    deviceSettings: () => settings,
    ...(options.brain ? { brain: options.brain } : {}),
    now: ctx.now,
  });
  const dispatcher = createDispatcher({
    store,
    runner,
    ctx,
    deviceSettings: () => settings,
  });
  send = (command) => dispatcher.dispatch(command);
  cleanups.push(async () => {
    await runner.shutdown();
    opened.close();
  });

  let commands = 0;
  const dispatch = (command: Record<string, unknown>) =>
    dispatcher.dispatch({ commandId: `cmd-${++commands}`, ...command });

  dispatch({ type: "project.add", root });
  const projectId = Object.keys(store.model.projects)[0] ?? "";

  const createThread = (
    runtimeMode: RuntimeMode,
    provider: ProviderKind = "demo",
    isolate = false,
  ) => {
    const { seq } = dispatch({
      type: "thread.create",
      projectId,
      provider,
      model: provider,
      runtimeMode,
      isolate,
    });
    const created = store.eventsAfter(seq - 1)[0];
    if (created?.type !== "thread.created") throw new Error("thread not created");
    return created.thread.id;
  };

  const startTurn = (threadId: string, prompt: string) => {
    const { seq } = dispatch({ type: "turn.start", threadId, prompt });
    const turnId = store.model.turns[threadId]?.at(-1)?.id ?? "";
    return { turnId, startedSeq: seq };
  };

  return { store, runner, dispatch, root, home, calls: fake.calls, createThread, startTurn };
}

/** Resolves when the signal aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

const at = "2026-01-01T00:00:00.000Z";

/** A store holding project p1 (root `root`) and an idle thread t1, as left by a previous process. */
function seededStore(home: string, root: string, thread: Partial<Thread> = {}): EventStore {
  const store = openEventStore(home, () => at);
  store.commit({
    commandId: "seed",
    events: [
      {
        type: "project.added",
        commandId: "seed",
        project: {
          id: "p1",
          name: "p",
          root,
          createdAt: at,
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
      },
      {
        type: "thread.created",
        commandId: "seed",
        thread: {
          id: "t1",
          projectId: "p1",
          title: "x",
          provider: "demo",
          model: "demo",
          runtimeMode: "full",
          worktree: null,
          providerSessionId: null,
          ownerDeviceId: null,
          movedTo: null,
          movedFrom: null,
          pullRequest: null,
          queue: [],
          status: "idle",
          createdAt: at,
          updatedAt: at,
          ...thread,
        },
      },
    ],
    effects: [],
  });
  return store;
}

function restart(home: string, git: GitService, adapters?: ProviderAdapter[]) {
  const ctx = testContext();
  const store = openEventStore(home, ctx.now);
  let send: (command: Command) => void = () => {};
  const runner = createEffectRunner({
    store,
    providers: createProviderRegistry(adapters ?? [createDemoAdapter({ stepMs: 0 })]),
    git,
    newId: ctx.newId,
    dispatch: (command) => send(command),
  });
  const dispatcher = createDispatcher({ store, runner, ctx });
  send = (command) => dispatcher.dispatch(command);
  runner.recover();
  return { store, runner, dispatcher };
}

function effectStatuses(home: string): string[] {
  const db = new DatabaseSync(join(home, "state.sqlite"));
  const rows = db.prepare("SELECT kind, status FROM effects ORDER BY id").all() as {
    kind: string;
    status: string;
  }[];
  db.close();
  return rows.map((row) => `${row.kind}:${row.status}`);
}

function finishedFor(store: EventStore, turnId: string) {
  return waitForEvent(store, "turn.finished", (event) => event.turnId === turnId);
}

function after(store: EventStore, seq: number): AgeEvent[] {
  return store.eventsAfter(seq);
}

describe("effect runner with the demo adapter", () => {
  it("runs a full turn and records events in order", async () => {
    const h = await harness();
    const threadId = h.createThread("full");
    const { turnId, startedSeq } = h.startTurn(threadId, "Add a line");
    const finished = await finishedFor(h.store, turnId);

    const events = after(h.store, startedSeq);
    const summary = events.map((event) =>
      event.type === "turn.itemUpserted"
        ? `${event.item.kind}${"status" in event.item ? `:${event.item.status}` : ""}`
        : event.type,
    );
    expect(summary).toEqual([
      "thread.sessionBound",
      "reasoning",
      "tool:running",
      "tool:done",
      "tool:running",
      "tool:done",
      "tool:done",
      "message",
      "turn.itemDelta",
      "turn.finished",
    ]);
    expect(finished).toMatchObject({
      status: "completed",
      checkpointAfter: `refs/wooky/checkpoints/${threadId}/${turnId}/after`,
      changedFiles: ["WOOKY_DEMO.md"],
      usage: { inputTokens: "Add a line".length, outputTokens: 12 },
      error: null,
      nativeRef: `demo:${turnId}`,
    });
    expect(h.calls).toEqual([
      `capture refs/wooky/checkpoints/${threadId}/${turnId}/before`,
      `capture refs/wooky/checkpoints/${threadId}/${turnId}/after`,
      `diff refs/wooky/checkpoints/${threadId}/${turnId}/before refs/wooky/checkpoints/${threadId}/${turnId}/after`,
    ]);
    expect(await readFile(join(h.root, "WOOKY_DEMO.md"), "utf8")).toBe("- Add a line\n");
    expect(h.store.model.threads[threadId]).toMatchObject({
      status: "idle",
      providerSessionId: `demo-${threadId}`,
    });
    const answer = h.store.model.turns[threadId]?.[0]?.items.find(
      (item) => item.kind === "message",
    );
    expect(answer).toMatchObject({
      text: "Done. I added a line to WOOKY_DEMO.md and ran echo ok.",
    });
  });

  it("asks for approvals and continues when allowed", async () => {
    const h = await harness();
    const threadId = h.createThread("approve");
    const { turnId } = h.startTurn(threadId, "Edit please");

    const edit = await waitForEvent(h.store, "approval.requested");
    expect(h.store.model.threads[threadId]?.status).toBe("waiting");
    const card = h.store.model.turns[threadId]?.[0]?.items.find((item) => item.id === edit.itemId);
    expect(card).toMatchObject({ kind: "approval", tool: "edit", decision: null });
    expect(card?.kind === "approval" && card.diff).toContain("+- Edit please");
    h.dispatch({
      type: "approval.respond",
      threadId,
      requestId: edit.requestId,
      decision: "allow",
    });

    const command = await waitForEvent(h.store, "approval.requested", () => true, edit.seq);
    h.dispatch({
      type: "approval.respond",
      threadId,
      requestId: command.requestId,
      decision: "allow",
    });

    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "completed" });
    const tools = h.store.model.turns[threadId]?.[0]?.items.filter((item) => item.kind === "tool");
    expect(tools?.map((item) => item.kind === "tool" && `${item.tool}:${item.status}`)).toEqual([
      "read:done",
      "edit:done",
      "command:done",
    ]);
    expect(await readFile(join(h.root, "WOOKY_DEMO.md"), "utf8")).toBe("- Edit please\n");
  });

  it("marks denied tools as failed and does not write the file", async () => {
    const h = await harness();
    const threadId = h.createThread("approve");
    const { turnId } = h.startTurn(threadId, "Edit please");

    const edit = await waitForEvent(h.store, "approval.requested");
    h.dispatch({ type: "approval.respond", threadId, requestId: edit.requestId, decision: "deny" });
    const command = await waitForEvent(h.store, "approval.requested", () => true, edit.seq);
    h.dispatch({
      type: "approval.respond",
      threadId,
      requestId: command.requestId,
      decision: "deny",
    });

    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "completed" });
    const items = h.store.model.turns[threadId]?.[0]?.items ?? [];
    expect(
      items
        .filter((item) => item.kind === "approval")
        .map((item) => item.kind === "approval" && item.decision),
    ).toEqual(["deny", "deny"]);
    expect(
      items
        .filter((item) => item.kind === "tool")
        .map((item) => item.kind === "tool" && item.status),
    ).toEqual(["done", "failed", "failed"]);
    await expect(readFile(join(h.root, "WOOKY_DEMO.md"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("asks only for commands in auto-edits mode", async () => {
    const h = await harness();
    const threadId = h.createThread("auto-edits");
    const { turnId } = h.startTurn(threadId, "Go");
    const request = await waitForEvent(h.store, "approval.requested");
    const card = h.store.model.turns[threadId]?.[0]?.items.find(
      (item) => item.id === request.itemId,
    );
    expect(card).toMatchObject({ tool: "command" });
    h.dispatch({
      type: "approval.respond",
      threadId,
      requestId: request.requestId,
      decision: "allow",
    });
    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "completed" });
  });

  it("interrupts a waiting turn with exactly one finish", async () => {
    const h = await harness();
    const threadId = h.createThread("approve");
    const { turnId } = h.startTurn(threadId, "Edit please");
    await waitForEvent(h.store, "approval.requested");

    h.dispatch({ type: "turn.interrupt", threadId });
    expect(await finishedFor(h.store, turnId)).toMatchObject({
      status: "interrupted",
      error: null,
    });
    await h.runner.idle();

    const finishes = h.store.eventsAfter(0).filter((event) => event.type === "turn.finished");
    expect(finishes).toHaveLength(1);
    const items = h.store.model.turns[threadId]?.[0]?.items ?? [];
    expect(items.find((item) => item.kind === "approval")).toMatchObject({ decision: "deny" });
    expect(items.some((item) => item.kind === "tool" && item.tool === "edit")).toBe(false);
    expect(h.store.model.threads[threadId]?.status).toBe("idle");
  });

  it("fails the turn when the demo agent is asked to fail", async () => {
    const h = await harness();
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "please fail");
    expect(await finishedFor(h.store, turnId)).toMatchObject({
      status: "failed",
      error: "The demo agent was asked to fail.",
    });
    expect(h.store.model.threads[threadId]?.status).toBe("error");
  });

  it("adds a notice and skips checkpoints outside a git repository", async () => {
    const h = await harness({ git: createNoopGitService() });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).toMatchObject({
      status: "completed",
      checkpointAfter: null,
      changedFiles: [],
    });
    expect(h.store.model.turns[threadId]?.[0]?.items[0]).toMatchObject({ kind: "notice" });
  });
});

describe("effect runner with scripted adapters", () => {
  it("coalesces deltas and flushes them before the next non-delta event", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield { type: "item", item: { kind: "message", id: "m1", role: "assistant", text: "" } };
          yield { type: "delta", itemId: "m1", text: "a" };
          yield { type: "delta", itemId: "m1", text: "b" };
          yield { type: "item", item: { kind: "reasoning", id: "r1", text: "" } };
          yield { type: "delta", itemId: "r1", text: "x" };
          yield { type: "delta", itemId: "m1", text: "c" };
          yield { type: "delta", itemId: "r1", text: "y" };
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId, startedSeq } = h.startTurn(threadId, "Go");
    await finishedFor(h.store, turnId);

    const stream = after(h.store, startedSeq).flatMap((event) => {
      if (event.type === "turn.itemDelta") return [`${event.itemId}+${event.text}`];
      if (event.type === "turn.itemUpserted" && event.item.kind !== "notice")
        return [`upsert ${event.item.id}`];
      return [];
    });
    expect(stream).toEqual(["upsert m1", "m1+ab", "upsert r1", "r1+xy", "m1+c"]);
    const items = h.store.model.turns[threadId]?.[0]?.items ?? [];
    expect(items.find((item) => item.id === "m1")).toMatchObject({ text: "abc" });
  });

  it("fails the turn when the adapter throws", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield { type: "session", sessionId: "s1" };
          throw new Error("cli crashed");
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).toMatchObject({
      status: "failed",
      error: "cli crashed",
    });
  });

  it("fails the turn when the adapter ends without done", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield { type: "session", sessionId: "s1" };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).toMatchObject({
      status: "failed",
      error: "The agent stopped without finishing its turn.",
    });
  });

  it("resumes the native session, and hands off the transcript after a provider switch", async () => {
    const inputs: TurnInput[] = [];
    const recorder = (kind: ProviderKind) =>
      scripted(kind, async function* (input) {
        inputs.push(input);
        yield { type: "session", sessionId: `${kind}-session` };
        yield {
          type: "item",
          item: {
            kind: "message",
            id: `${input.turnId}-a`,
            role: "assistant",
            text: `answer from ${kind}`,
          },
        };
        yield { type: "done", status: "completed", error: null };
      });
    const h = await harness({ adapters: [recorder("demo"), recorder("codex")] });
    const threadId = h.createThread("full");

    await finishedFor(h.store, h.startTurn(threadId, "first").turnId);
    await finishedFor(h.store, h.startTurn(threadId, "second").turnId);
    h.dispatch({ type: "thread.configure", threadId, provider: "codex", model: "gpt" });
    await finishedFor(h.store, h.startTurn(threadId, "third").turnId);

    expect(inputs.map((input) => [input.resumeSessionId, input.handoffContext])).toEqual([
      [null, null],
      ["demo-session", null],
      [
        null,
        "User: first\n\nAssistant: answer from demo\n\nUser: second\n\nAssistant: answer from demo",
      ],
    ]);
    expect(inputs[2]?.model).toBe("gpt");
  });
});

describe("effect runner effects and recovery", () => {
  it("binds a worktree before running the first turn of an isolated thread", async () => {
    const inputs: TurnInput[] = [];
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          inputs.push(input);
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const projectId = Object.keys(h.store.model.projects)[0];
    h.dispatch({
      type: "thread.create",
      projectId,
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: true,
    });
    const threadId = Object.keys(h.store.model.threads)[0] ?? "";
    const { turnId } = h.startTurn(threadId, "Go");
    await finishedFor(h.store, turnId);

    const bound = await waitForEvent(h.store, "thread.worktreeBound");
    expect(bound.worktree.path).toBe(join(h.root, ".worktrees", threadId));
    expect(inputs[0]?.cwd).toBe(bound.worktree.path);

    h.dispatch({ type: "thread.remove", threadId });
    await h.runner.idle();
    expect(h.calls).toContain(`removeWorktree ${bound.worktree.path}`);
  });

  it("reverts a turn by restoring its checkpoint", async () => {
    const h = await harness();
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    await finishedFor(h.store, turnId);
    h.dispatch({ type: "turn.revert", threadId, turnId });
    await waitForEvent(h.store, "turn.reverted");
    expect(h.calls).toContain(`restore refs/wooky/checkpoints/${threadId}/${turnId}/before`);
    expect(h.store.model.turns[threadId]).toEqual([]);
  });

  it("finishes stale running turns as interrupted and retires old effects on startup", async () => {
    const home = await tempDir("recovery");
    const ctx = testContext();
    const store = openEventStore(home, ctx.now);
    store.commit({
      commandId: "c1",
      events: [
        {
          type: "project.added",
          commandId: "c1",
          project: {
            id: "p1",
            name: "p",
            root: "/p",
            createdAt: at,
            settings: { scripts: [], sharedPaths: [], prompts: [] },
          },
        },
        {
          type: "thread.created",
          commandId: "c1",
          thread: {
            id: "t1",
            projectId: "p1",
            title: "x",
            provider: "demo",
            model: "demo",
            runtimeMode: "full",
            worktree: null,
            providerSessionId: null,
            ownerDeviceId: null,
            movedTo: null,
            movedFrom: null,
            pullRequest: null,
            queue: [],
            status: "idle",
            createdAt: at,
            updatedAt: at,
          },
        },
        {
          type: "turn.started",
          commandId: "c1",
          threadId: "t1",
          turnId: "u1",
          prompt: "x",
          provider: "demo",
          model: "demo",
          checkpointBefore: null,
        },
      ],
      effects: [{ kind: "turn.run", threadId: "t1", turnId: "u1" }],
    });
    store.close();

    const reopened = openEventStore(home, ctx.now);
    const runner: EffectRunner = createEffectRunner({
      store: reopened,
      providers: createProviderRegistry([createDemoAdapter({ stepMs: 0 })]),
      git: createFakeGit().git,
      newId: ctx.newId,
    });
    runner.recover();
    const finishes = reopened.eventsAfter(0).filter((event) => event.type === "turn.finished");
    expect(finishes).toMatchObject([{ turnId: "u1", status: "interrupted" }]);
    expect(reopened.model.threads.t1?.status).toBe("idle");
    reopened.close();

    const db = new DatabaseSync(join(home, "state.sqlite"));
    expect(db.prepare("SELECT status FROM effects").all()).toEqual([{ status: "retired" }]);
    db.close();
  });

  it("re-runs a revert that a crash left pending and records it exactly once", async () => {
    const home = await tempDir("recovery");
    const root = await tempDir("project");
    const first = seededStore(home, root);
    const turn = {
      type: "turn.started" as const,
      commandId: "c1",
      threadId: "t1",
      turnId: "u1",
      prompt: "x",
      provider: "demo" as const,
      model: "demo",
      checkpointBefore: "refs/wooky/checkpoints/t1/u1/before",
    };
    first.commit({ commandId: "c1", events: [turn], effects: [] });
    first.appendInternal([
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "completed",
        checkpointAfter: "refs/wooky/checkpoints/t1/u1/after",
        changedFiles: [],
        usage: null,
        error: null,
      },
    ]);
    // The revert is committed, then the process dies before the effect runs.
    first.commit({
      commandId: "c2",
      events: [],
      effects: [
        {
          kind: "checkpoint.restore",
          threadId: "t1",
          turnId: "u1",
          cwd: root,
          ref: "refs/wooky/checkpoints/t1/u1/before",
        },
      ],
    });
    first.close();

    const fake = createFakeGit();
    const second = restart(home, fake.git);
    await second.runner.idle();
    expect(fake.calls).toEqual(["restore refs/wooky/checkpoints/t1/u1/before"]);
    expect(second.store.model.turns.t1).toEqual([]);
    await second.runner.shutdown();
    second.store.close();

    const third = restart(home, fake.git);
    await third.runner.idle();
    const reverts = third.store.eventsAfter(0).filter((event) => event.type === "turn.reverted");
    expect(reverts).toMatchObject([{ turnId: "u1" }]);
    expect(fake.calls).toHaveLength(1);
    await third.runner.shutdown();
    third.store.close();
    expect(effectStatuses(home)).toEqual(["checkpoint.restore:done"]);
  });

  it("does not record a second revert when the crash came after turn.reverted", async () => {
    const home = await tempDir("recovery");
    const root = await tempDir("project");
    const first = seededStore(home, root);
    first.commit({
      commandId: "c1",
      events: [
        {
          type: "turn.started",
          commandId: "c1",
          threadId: "t1",
          turnId: "u1",
          prompt: "x",
          provider: "demo",
          model: "demo",
          checkpointBefore: "refs/wooky/checkpoints/t1/u1/before",
        },
      ],
      effects: [],
    });
    first.commit({
      commandId: "c2",
      events: [],
      effects: [
        {
          kind: "checkpoint.restore",
          threadId: "t1",
          turnId: "u1",
          cwd: root,
          ref: "refs/wooky/checkpoints/t1/u1/before",
        },
      ],
    });
    first.appendInternal([
      { type: "turn.reverted", commandId: null, threadId: "t1", turnId: "u1" },
    ]);
    first.close();

    const second = restart(home, createFakeGit().git);
    await second.runner.idle();
    const reverts = second.store.eventsAfter(0).filter((event) => event.type === "turn.reverted");
    expect(reverts).toHaveLength(1);
    await second.runner.shutdown();
    second.store.close();
  });

  it("re-runs a worktree removal that a crash left pending", async () => {
    const home = await tempDir("recovery");
    const root = await tempDir("project");
    const worktree = { path: join(root, ".worktrees", "t1"), branch: "wooky/t1" };
    const first = seededStore(home, root, { worktree });
    first.commit({
      commandId: "c1",
      events: [{ type: "thread.removed", commandId: "c1", threadId: "t1" }],
      effects: [{ kind: "worktree.remove", threadId: "t1", projectRoot: root, worktree }],
    });
    first.close();

    const fake = createFakeGit();
    const second = restart(home, fake.git);
    await second.runner.idle();
    expect(fake.calls).toEqual([`removeWorktree ${worktree.path}`]);
    await second.runner.shutdown();
    second.store.close();
    expect(effectStatuses(home)).toEqual(["worktree.remove:done"]);
  });

  it("re-creates an isolated thread's worktree that a crash left pending", async () => {
    const home = await tempDir("recovery");
    const root = await tempDir("project");
    const first = seededStore(home, root, { isolate: true });
    first.commit({
      commandId: "c1",
      events: [],
      effects: [{ kind: "worktree.create", threadId: "t1", projectRoot: root }],
    });
    first.close();

    const fake = createFakeGit();
    const second = restart(home, fake.git);
    await second.runner.idle();
    expect(fake.calls).toEqual(["createWorktree t1"]);
    expect(second.store.model.threads.t1?.worktree?.path).toBe(join(root, ".worktrees", "t1"));
    await second.runner.shutdown();
    second.store.close();
  });

  it("creates a missing worktree before running a turn on an isolated thread", async () => {
    const home = await tempDir("recovery");
    const root = await tempDir("project");
    seededStore(home, root, { isolate: true }).close();
    const inputs: TurnInput[] = [];
    const fake = createFakeGit();
    const { store, runner } = restart(home, fake.git, [
      scripted("demo", async function* (input) {
        inputs.push(input);
        yield { type: "done", status: "completed", error: null };
      }),
    ]);
    const dispatcher = createDispatcher({ store, runner, ctx: testContext() });
    dispatcher.dispatch({ type: "turn.start", commandId: "c1", threadId: "t1", prompt: "Go" });
    const turnId = store.model.turns.t1?.[0]?.id ?? "";
    expect(await finishedFor(store, turnId)).toMatchObject({ status: "completed" });
    expect(inputs[0]?.cwd).toBe(join(root, ".worktrees", "t1"));
    await runner.shutdown();
    store.close();
  });

  it("fails a turn on an isolated thread whose worktree cannot be created", async () => {
    const fake = createFakeGit();
    const git: GitService = {
      ...fake.git,
      createWorktree: async () => {
        throw new Error("disk is full");
      },
    };
    const inputs: TurnInput[] = [];
    const h = await harness({
      git,
      adapters: [
        scripted("demo", async function* (input) {
          inputs.push(input);
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full", "demo", true);
    expect(h.store.model.threads[threadId]?.isolate).toBe(true);
    const { turnId } = h.startTurn(threadId, "Go");
    const finished = await finishedFor(h.store, turnId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("disk is full");
    expect(inputs).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("effect runner hardening", () => {
  it("rejects reverting a turn that has no checkpoint", async () => {
    const h = await harness({ git: createNoopGitService() });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    await finishedFor(h.store, turnId);
    expect(() => h.dispatch({ type: "turn.revert", threadId, turnId })).toThrow(
      /no checkpoint, so it cannot be reverted/,
    );
  });

  it("drops invalid adapter events instead of poisoning the log", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield {
            type: "item",
            item: { kind: "message", id: "m1", role: "bot", text: "hi" },
          } as unknown as ProviderEvent;
          yield { type: "delta", itemId: "", text: "x" };
          yield {
            type: "item",
            item: { kind: "message", id: "m2", role: "assistant", text: "ok" },
          };
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "completed" });
    const items = h.store.model.turns[threadId]?.[0]?.items ?? [];
    expect(items.some((item) => item.id === "m1")).toBe(false);
    expect(items.some((item) => item.id === "m2")).toBe(true);
    expect(
      items.filter((item) => item.kind === "notice" && item.text.includes("could not read")),
    ).toHaveLength(2);

    await h.runner.shutdown();
    const reopened = openEventStore(h.home, () => at);
    expect(reopened.model.turns[threadId]?.[0]?.status).toBe("completed");
    reopened.close();
  });

  it("fails the turn when an adapter keeps sending invalid events", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          for (let i = 0; i < 50; i++)
            yield { type: "usage", usage: { inputTokens: -1, outputTokens: 0 } };
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    const finished = await finishedFor(h.store, turnId);
    expect(finished).toMatchObject({ status: "failed" });
    expect(finished.error).toMatch(/unreadable events/);
  });

  it("denies approvals in full mode once the turn is aborted", async () => {
    const answers: string[] = [];
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          yield { type: "session", sessionId: "s1" };
          await aborted(input.signal);
          answers.push(
            await input.requestApproval({
              requestId: "r1",
              tool: "command",
              title: "rm -rf build",
              detail: "",
            }),
          );
          yield { type: "done", status: "interrupted", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    await waitForEvent(h.store, "thread.sessionBound");
    h.dispatch({ type: "turn.interrupt", threadId });
    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "interrupted" });
    expect(answers).toEqual(["deny"]);
  });

  it("retries recording the end of a turn when the first append fails", async () => {
    let failed = false;
    const h = await harness({
      wrapStore: (store) => {
        const flaky: EventStore = Object.create(store);
        flaky.appendInternal = (events) => {
          if (!failed && events.some((event) => event.type === "turn.finished")) {
            failed = true;
            throw new Error("database is locked");
          }
          return store.appendInternal(events);
        };
        return flaky;
      },
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    await h.runner.idle();
    expect(failed).toBe(true);
    const finishes = h.store.eventsAfter(0).filter((event) => event.type === "turn.finished");
    expect(finishes).toMatchObject([{ turnId, status: "completed" }]);
    expect(h.store.model.threads[threadId]?.status).toBe("idle");
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const dbQuestion = {
  id: "db",
  question: "Which database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  multiSelect: false,
  allowCustom: false,
};

describe("effect runner seams for revert rewind and questions", () => {
  it("records the done event's nativeRef on turn.finished and the turn", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield { type: "done", status: "completed", error: null, nativeRef: "msg-42" };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).toMatchObject({ nativeRef: "msg-42" });
    expect(h.store.model.turns[threadId]?.at(-1)?.nativeRef).toBe("msg-42");
  });

  it("leaves nativeRef out when the adapter reports none", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).not.toHaveProperty("nativeRef");
  });

  it("delivers question answers to the adapter while its turn is still running", async () => {
    const received = deferred<unknown>();
    const release = deferred();
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          const answers = await input.requestUserInput({
            requestId: "r1",
            questions: [dbQuestion],
          });
          received.resolve(answers);
          await release.promise;
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    const asked = await waitForEvent(h.store, "question.requested");
    expect(asked).toMatchObject({ turnId, requestId: "r1", questions: [dbQuestion] });
    expect(h.store.model.threads[threadId]?.status).toBe("waiting");

    const result = h.dispatch({
      type: "question.respond",
      threadId,
      requestId: "r1",
      answers: { db: ["SQLite"] },
    });
    expect(result).toMatchObject({ accepted: true });
    expect(await received.promise).toEqual({ db: ["SQLite"] });
    expect(h.store.model.turns[threadId]?.at(-1)?.status).toBe("running");
    expect(h.store.model.threads[threadId]?.status).toBe("running");

    release.resolve();
    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "completed" });
    const item = h.store.model.turns[threadId]?.at(-1)?.items.find((i) => i.kind === "question");
    expect(item).toMatchObject({ requestId: "r1", answers: { db: ["SQLite"] } });
  });

  it("resolves an open question to null when the turn is interrupted", async () => {
    const received = deferred<unknown>();
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          received.resolve(
            await input.requestUserInput({ requestId: "r1", questions: [dbQuestion] }),
          );
          yield { type: "done", status: "interrupted", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    await waitForEvent(h.store, "question.requested");
    h.dispatch({ type: "turn.interrupt", threadId });
    expect(await received.promise).toBeNull();
    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "interrupted" });
  });

  it("does nothing when the reverted turn is still in the model", async () => {
    const rewound: unknown[] = [];
    const adapter = scripted("demo", async function* () {
      yield { type: "session", sessionId: "s1" };
      yield { type: "done", status: "completed", error: null, nativeRef: "msg-1" };
    });
    adapter.rewind = async (input) => {
      rewound.push(input);
      return { sessionId: "rewound" };
    };
    const h = await harness({ adapters: [adapter] });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    await finishedFor(h.store, turnId);
    const { effects } = h.store.commit({
      commandId: "rewind",
      events: [],
      effects: [{ kind: "session.rewind", threadId, turnId, keepNativeRef: null, dropTurns: 1 }],
    });
    h.runner.enqueue(effects);
    await h.runner.idle();
    expect(rewound).toEqual([]);
    expect(effectStatuses(h.home).at(-1)).toBe("session.rewind:done");
    expect(h.store.model.turns[threadId]).toHaveLength(1);
  });
});

describe("effect runner rewind, questions, queue and plans", () => {
  function recording(nativeRefFor: (input: TurnInput) => string) {
    const inputs: TurnInput[] = [];
    const adapter = scripted("demo", async function* (input) {
      inputs.push(input);
      yield { type: "session", sessionId: input.resumeSessionId ?? "native" };
      yield {
        type: "item",
        item: {
          kind: "message",
          id: `${input.turnId}-a`,
          role: "assistant",
          text: input.prompt,
        },
      };
      yield { type: "done", status: "completed", error: null, nativeRef: nativeRefFor(input) };
    });
    return { adapter, inputs };
  }

  it("calls rewind with the kept ref and resumes that session", async () => {
    const { adapter, inputs } = recording(() => `ref-${inputs.length}`);
    const rewound: { keepNativeRef: string | null; dropTurns: number; sessionId: string }[] = [];
    let secondId = "";
    let turnWasGone = false;
    let readTurns: () => readonly { id: string }[] = () => [];
    adapter.rewind = async (input) => {
      rewound.push({
        keepNativeRef: input.keepNativeRef,
        dropTurns: input.dropTurns,
        sessionId: input.sessionId,
      });
      turnWasGone = !readTurns().some((turn) => turn.id === secondId);
      return { sessionId: "rewound" };
    };
    const h = await harness({ adapters: [adapter] });
    const threadId = h.createThread("full");
    readTurns = () => h.store.model.turns[threadId] ?? [];
    await finishedFor(h.store, h.startTurn(threadId, "first").turnId);
    const second = h.startTurn(threadId, "second");
    secondId = second.turnId;
    await finishedFor(h.store, second.turnId);
    h.dispatch({ type: "turn.revert", threadId, turnId: second.turnId });
    await waitForEvent(
      h.store,
      "thread.sessionBound",
      (event) => event.providerSessionId === "rewound",
    );
    expect(turnWasGone).toBe(true);
    expect(h.store.model.turns[threadId]?.some((turn) => turn.id === second.turnId)).toBe(false);
    expect(rewound).toEqual([{ keepNativeRef: "ref-1", dropTurns: 1, sessionId: "native" }]);
    expect(h.calls.some((call) => call.startsWith("restore "))).toBe(true);

    await finishedFor(h.store, h.startTurn(threadId, "third").turnId);
    expect(inputs.at(-1)).toMatchObject({ resumeSessionId: "rewound", resumeAt: null });
  });

  it("clears the session when the adapter cannot rewind", async () => {
    const { adapter, inputs } = recording(() => "ref");
    const h = await harness({ adapters: [adapter] });
    const threadId = h.createThread("full");
    await finishedFor(h.store, h.startTurn(threadId, "first").turnId);
    const second = h.startTurn(threadId, "second");
    await finishedFor(h.store, second.turnId);
    h.dispatch({ type: "turn.revert", threadId, turnId: second.turnId, restoreFiles: false });
    await waitForEvent(h.store, "thread.sessionBound", (event) => event.providerSessionId === null);
    expect(h.calls.some((call) => call.startsWith("restore "))).toBe(false);
    await finishedFor(h.store, h.startTurn(threadId, "third").turnId);
    expect(inputs.at(-1)?.resumeSessionId).toBeNull();
    expect(inputs.at(-1)?.resumeAt).toBeNull();
    expect(inputs.at(-1)?.handoffContext).toContain("User: first");
    expect(inputs.at(-1)?.handoffContext).not.toContain("second");
  });

  it("passes resumeAt once when the adapter supports resume-at", async () => {
    const { adapter, inputs } = recording(() => `ref-${inputs.length}`);
    adapter.supportsResumeAt = true;
    const h = await harness({ adapters: [adapter] });
    const threadId = h.createThread("full");
    await finishedFor(h.store, h.startTurn(threadId, "first").turnId);
    const second = h.startTurn(threadId, "second");
    await finishedFor(h.store, second.turnId);
    h.dispatch({ type: "turn.revert", threadId, turnId: second.turnId, restoreFiles: false });
    await h.runner.idle();
    expect(effectStatuses(h.home)).toContain("session.rewind:pending");

    await finishedFor(h.store, h.startTurn(threadId, "third").turnId);
    expect(inputs.at(-1)?.resumeAt).toBe("ref-1");
    await finishedFor(h.store, h.startTurn(threadId, "fourth").turnId);
    expect(inputs.at(-1)?.resumeAt).toBeNull();
    expect(effectStatuses(h.home)).toContain("session.rewind:done");
    expect(effectStatuses(h.home)).not.toContain("session.rewind:pending");
  });

  it("still resumes at the kept message after a restart", async () => {
    const home = await tempDir("resume-at");
    const root = await tempDir("project");
    const seeded = seededStore(home, root, { providerSessionId: "native" });
    const started = {
      type: "turn.started" as const,
      commandId: "c1",
      threadId: "t1",
      turnId: "u1",
      prompt: "first",
      provider: "demo" as const,
      model: "demo",
      checkpointBefore: "refs/wooky/checkpoints/t1/u1/before",
    };
    seeded.commit({ commandId: "c1", events: [started], effects: [] });
    seeded.appendInternal([
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "completed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
        nativeRef: "ref-1",
      },
    ]);
    seeded.commit({
      commandId: "c2",
      events: [{ ...started, commandId: "c2", turnId: "u2", prompt: "second" }],
      effects: [],
    });
    seeded.appendInternal([
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u2",
        status: "completed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
        nativeRef: "ref-2",
      },
    ]);
    seeded.commit({
      commandId: "revert",
      events: [
        {
          type: "turn.reverted",
          commandId: "revert",
          threadId: "t1",
          turnId: "u2",
          restoredFiles: false,
        },
      ],
      effects: [
        {
          kind: "session.rewind",
          threadId: "t1",
          turnId: "u2",
          keepNativeRef: "ref-1",
          dropTurns: 1,
        },
      ],
    });
    seeded.close();

    const inputs: TurnInput[] = [];
    const adapter = scripted("demo", async function* (input) {
      inputs.push(input);
      yield { type: "done", status: "completed", error: null };
    });
    adapter.supportsResumeAt = true;
    const second = restart(home, createFakeGit().git, [adapter]);
    await second.runner.idle();
    second.dispatcher.dispatch({
      type: "turn.start",
      commandId: "c3",
      threadId: "t1",
      prompt: "third",
    });
    const thirdId = second.store.model.turns.t1?.at(-1)?.id ?? "";
    await finishedFor(second.store, thirdId);
    expect(inputs[0]?.resumeAt).toBe("ref-1");
    second.dispatcher.dispatch({
      type: "turn.start",
      commandId: "c4",
      threadId: "t1",
      prompt: "fourth",
    });
    const fourthId = second.store.model.turns.t1?.at(-1)?.id ?? "";
    await finishedFor(second.store, fourthId);
    expect(inputs[1]?.resumeAt).toBeNull();
    await second.runner.shutdown();
    second.store.close();

    const again: TurnInput[] = [];
    const later = scripted("demo", async function* (input) {
      again.push(input);
      yield { type: "done", status: "completed", error: null };
    });
    later.supportsResumeAt = true;
    const third = restart(home, createFakeGit().git, [later]);
    third.dispatcher.dispatch({
      type: "turn.start",
      commandId: "c5",
      threadId: "t1",
      prompt: "fifth",
    });
    await third.runner.idle();
    expect(again[0]?.resumeAt).toBeNull();
    await third.runner.shutdown();
    third.store.close();
  });

  it("clears question listeners when the adapter throws mid-question", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          void input.requestUserInput({ requestId: "r1", questions: [dbQuestion] });
          if (input.turnId) throw new Error("mid-question");
          yield { type: "done", status: "failed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "Go");
    expect(await finishedFor(h.store, turnId)).toMatchObject({ status: "failed" });
    await h.runner.idle();
    expect(h.runner.pendingRequests()).toBe(0);
  });

  it("resolves open questions and approvals on abort, before the turn finishes", async () => {
    const received = deferred<{ question: unknown; approval: unknown }>();
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          const question = input.requestUserInput({ requestId: "rq", questions: [dbQuestion] });
          const approval = input.requestApproval({
            requestId: "ra",
            tool: "command",
            title: "run",
            detail: "",
          });
          received.resolve({ question: await question, approval: await approval });
          yield { type: "done", status: "interrupted", error: null };
        }),
      ],
    });
    const threadId = h.createThread("approve");
    const { turnId } = h.startTurn(threadId, "Go");
    await waitForEvent(h.store, "question.requested", (event) => event.requestId === "rq");
    await waitForEvent(h.store, "approval.requested", (event) => event.requestId === "ra");
    h.dispatch({ type: "turn.interrupt", threadId });
    expect(await received.promise).toEqual({ question: null, approval: "deny" });
    const finished = await finishedFor(h.store, turnId);
    const question = h.store.eventsAfter(0).find((event) => event.type === "question.resolved");
    const approval = h.store.eventsAfter(0).find((event) => event.type === "approval.resolved");
    expect(question).toMatchObject({ answers: null, requestId: "rq" });
    expect(approval).toMatchObject({ decision: "deny", requestId: "ra" });
    expect(question && question.seq).toBeLessThan(finished.seq);
    expect(approval && approval.seq).toBeLessThan(finished.seq);
    expect(() =>
      h.dispatch({
        type: "question.respond",
        threadId,
        requestId: "rq",
        answers: { db: ["SQLite"] },
      }),
    ).toThrow(/already answered or dismissed/);
    expect(h.runner.pendingRequests()).toBe(0);
  });

  it("starts a queued prompt once, and not again after a restart", async () => {
    const home = await tempDir("queue-once");
    const root = await tempDir("project");
    const seeded = seededStore(home, root);
    seeded.commit({
      commandId: "c1",
      events: [
        {
          type: "turn.started",
          commandId: "c1",
          threadId: "t1",
          turnId: "u1",
          prompt: "first",
          provider: "demo",
          model: "demo",
          checkpointBefore: "refs/wooky/checkpoints/t1/u1/before",
        },
      ],
      effects: [],
    });
    seeded.appendInternal([
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "completed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
      },
    ]);
    seeded.commit({
      commandId: "q",
      events: [
        {
          type: "queue.added",
          commandId: "q",
          threadId: "t1",
          item: { id: "q1", prompt: "second", queuedAt: at },
        },
      ],
      effects: [],
    });
    seeded.close();

    const prompts: string[] = [];
    const adapter = scripted("demo", async function* (input) {
      prompts.push(input.prompt);
      yield { type: "done", status: "completed", error: null };
    });
    const second = restart(home, createFakeGit().git, [adapter]);
    const started = await waitForEvent(
      second.store,
      "turn.started",
      (event) => event.fromQueueId === "q1",
    );
    await finishedFor(second.store, started.turnId);
    expect(prompts).toEqual(["second"]);
    await second.runner.shutdown();
    second.store.close();

    const third = restart(home, createFakeGit().git, [adapter]);
    await third.runner.idle();
    const queuedStarts = third.store
      .eventsAfter(0)
      .filter((event) => event.type === "turn.started" && event.fromQueueId === "q1");
    expect(queuedStarts).toHaveLength(1);
    expect(prompts).toEqual(["second"]);
    await third.runner.shutdown();
    third.store.close();
  });

  it("auto-advances a queue after a completed turn and holds it after failure or interrupt", async () => {
    const release = deferred();
    const h = await harness({
      adapters: [
        scripted("demo", async function* (input) {
          if (input.prompt === "wait") await Promise.race([release.promise, aborted(input.signal)]);
          const failed = input.prompt === "fail";
          yield {
            type: "done",
            status: failed ? "failed" : input.signal.aborted ? "interrupted" : "completed",
            error: failed ? "no" : null,
          };
        }),
      ],
    });
    const failedId = h.createThread("full");
    h.startTurn(failedId, "fail");
    h.dispatch({ type: "turn.start", threadId: failedId, prompt: "later", whenBusy: "queue" });
    await h.runner.idle();
    expect(h.store.model.threads[failedId]?.queue).toMatchObject([{ prompt: "later" }]);
    expect(
      h.store.eventsAfter(0).some((event) => event.type === "turn.started" && event.fromQueueId),
    ).toBe(false);

    const heldId = h.createThread("full");
    const held = h.startTurn(heldId, "wait");
    h.dispatch({ type: "turn.start", threadId: heldId, prompt: "stay", whenBusy: "queue" });
    h.dispatch({ type: "turn.interrupt", threadId: heldId });
    expect(await finishedFor(h.store, held.turnId)).toMatchObject({ status: "interrupted" });
    await h.runner.idle();
    expect(h.store.model.threads[heldId]?.queue).toMatchObject([{ prompt: "stay" }]);

    const threadId = h.createThread("full");
    const waiting = h.startTurn(threadId, "wait");
    h.dispatch({ type: "turn.start", threadId, prompt: "queued", whenBusy: "queue" });
    const queuedId = h.store.model.threads[threadId]?.queue[0]?.id ?? "";
    release.resolve();
    await finishedFor(h.store, waiting.turnId);
    const promoted = await waitForEvent(
      h.store,
      "turn.started",
      (event) => event.fromQueueId === queuedId,
    );
    await finishedFor(h.store, promoted.turnId);
    expect(h.store.model.threads[threadId]?.queue).toEqual([]);
  });

  it("accepts a proposed plan when the next turn runs in default mode", async () => {
    const modes: string[] = [];
    const h = await harness({
      capabilities: (provider) => (provider === "demo" ? { planMode: true } : undefined),
      adapters: [
        scripted("demo", async function* (input) {
          modes.push(input.interactionMode);
          if (input.interactionMode === "plan")
            yield { type: "plan", itemId: "plan-1", markdown: "# Ship it\n" };
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const threadId = h.createThread("full");
    h.dispatch({ type: "thread.configure", threadId, interactionMode: "plan" });
    await finishedFor(h.store, h.startTurn(threadId, "Plan the work").turnId);
    const plan = () =>
      h.store.model.turns[threadId]
        ?.flatMap((turn) => turn.items)
        .find((item) => item.kind === "plan");
    expect(plan()).toMatchObject({ id: "plan-1", status: "proposed" });

    h.dispatch({ type: "thread.configure", threadId, interactionMode: "default" });
    const started = h.startTurn(threadId, "Implement the plan above.");
    await waitForEvent(
      h.store,
      "turn.itemUpserted",
      (event) => event.item.kind === "plan" && event.item.status === "accepted",
    );
    expect(plan()).toMatchObject({ id: "plan-1", status: "accepted" });
    await finishedFor(h.store, started.turnId);
    expect(modes).toEqual(["plan", "default"]);
  });
});

describe("failover effect runner", () => {
  const rateLimit: TurnFailure = { kind: "rate_limit", message: "slow down" };

  function claudeCodexHarness(
    settings: DeviceSettings,
    primary: (input: TurnInput) => AsyncIterable<ProviderEvent>,
    fallback: (input: TurnInput) => AsyncIterable<ProviderEvent>,
  ) {
    return harness({
      deviceSettings: settings,
      adapters: [
        scripted("claude", primary, [{ id: "sonnet", label: "Sonnet" }]),
        scripted("codex", fallback, [{ id: "gpt-6.1-sol", label: "Sol" }]),
      ],
    });
  }

  async function createClaudeThread(h: Awaited<ReturnType<typeof harness>>) {
    const projectId = Object.keys(h.store.model.projects)[0] ?? "";
    h.dispatch({
      type: "thread.create",
      projectId,
      provider: "claude",
      model: "sonnet",
      runtimeMode: "full",
      isolate: false,
    });
    const created = h.store.eventsAfter(0).find((event) => event.type === "thread.created");
    if (created?.type !== "thread.created") throw new Error("thread not created");
    return created.thread.id;
  }

  it("failsover to the next available model and retries with the same prompt", async () => {
    const prompts: string[] = [];
    const h = await claudeCodexHarness(
      DeviceSettings.parse({
        failover: FailoverSettings.parse({
          chain: [{ provider: "codex", model: "gpt-6.1-sol" }],
        }),
      }),
      async function* (input) {
        prompts.push(input.prompt);
        yield { type: "done", status: "failed", error: "rate", failure: rateLimit };
      },
      async function* (input) {
        prompts.push(input.prompt);
        yield { type: "done", status: "completed", error: null };
      },
    );
    const threadId = await createClaudeThread(h);
    const prompt = "Ship the failover path";
    const { turnId } = h.startTurn(threadId, prompt);
    await finishedFor(h.store, turnId);
    await h.runner.idle();
    const retry = h.store.model.turns[threadId]?.at(-1);
    expect(retry?.provider).toBe("codex");
    expect(retry?.prompt).toBe(prompt);
    expect(prompts).toEqual([prompt, prompt]);
    expect(h.store.model.cooldowns.claude?.reason).toBe("rate_limit");
    // The retry completed, so the per-prompt switch budget is back to 0.
    expect(h.store.model.threads[threadId]?.failover?.switches).toBe(0);
  });

  it("stops at max switches and records cooldown only", async () => {
    const h = await claudeCodexHarness(
      DeviceSettings.parse({
        failover: FailoverSettings.parse({
          chain: [{ provider: "codex", model: "gpt-6.1-sol" }],
          maxSwitchesPerPrompt: 1,
        }),
      }),
      async function* () {
        yield { type: "done", status: "failed", error: "rate", failure: rateLimit };
      },
      async function* () {
        yield { type: "done", status: "failed", error: "still", failure: rateLimit };
      },
    );
    const threadId = await createClaudeThread(h);
    const { turnId } = h.startTurn(threadId, "once more");
    await finishedFor(h.store, turnId);
    await h.runner.idle();
    const retryId = h.store.model.turns[threadId]?.at(-1)?.id ?? "";
    await finishedFor(h.store, retryId);
    await h.runner.idle();
    expect(h.store.model.turns[threadId]).toHaveLength(2);
    expect(h.store.model.cooldowns.codex?.reason).toBe("rate_limit");
  });

  it("ignores failover when disabled or the failure is not a trigger", async () => {
    const h = await claudeCodexHarness(
      DeviceSettings.parse({ failover: FailoverSettings.parse({ enabled: false }) }),
      async function* () {
        yield { type: "done", status: "failed", error: "rate", failure: rateLimit };
      },
      async function* () {
        yield { type: "done", status: "completed", error: null };
      },
    );
    const threadId = await createClaudeThread(h);
    const { turnId } = h.startTurn(threadId, "nope");
    await finishedFor(h.store, turnId);
    await h.runner.idle();
    expect(h.store.model.turns[threadId]).toHaveLength(1);
  });

  it("treats a duplicate failover command as idempotent", async () => {
    const h = await claudeCodexHarness(
      DeviceSettings.parse({
        failover: FailoverSettings.parse({
          chain: [{ provider: "codex", model: "gpt-6.1-sol" }],
        }),
      }),
      async function* () {
        yield { type: "done", status: "failed", error: "rate", failure: rateLimit };
      },
      async function* () {
        yield { type: "done", status: "completed", error: null };
      },
    );
    const threadId = await createClaudeThread(h);
    const { turnId } = h.startTurn(threadId, "dup");
    await finishedFor(h.store, turnId);
    await h.runner.idle();
    const turnsAfter = h.store.model.turns[threadId]?.length ?? 0;
    h.dispatch({
      commandId: `failover:${turnId}`,
      type: "thread.failover",
      threadId,
      to: { provider: "codex", model: "gpt-6.1-sol" },
      failure: rateLimit,
      retryPrompt: "dup",
    });
    await h.runner.idle();
    expect(h.store.model.turns[threadId]?.length).toBe(turnsAfter);
  });

  it("carries done.failure through turn.finished", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield {
            type: "done",
            status: "failed",
            error: "rate",
            failure: rateLimit,
          };
        }),
      ],
    });
    const threadId = h.createThread("full");
    const { turnId } = h.startTurn(threadId, "x");
    const finished = await finishedFor(h.store, turnId);
    expect(finished.failure).toEqual(rateLimit);
  });
});

describe("fleet worker reports", () => {
  it("queues a coordinator follow-up once per worker turn", async () => {
    const h = await harness({
      adapters: [
        scripted("demo", async function* () {
          yield {
            type: "item",
            item: { kind: "message", id: "m1", role: "assistant", text: "shipped" },
          };
          yield { type: "done", status: "completed", error: null };
        }),
      ],
    });
    const coordId = h.createThread("full");
    h.dispatch({
      type: "thread.spawn",
      parentThreadId: coordId,
      provider: "demo",
      model: "demo",
      prompt: "work",
    });
    await h.runner.idle();
    const workerId = childrenOf(h.store.model, coordId).at(-1)?.id ?? "";
    expect(workerId).not.toBe("");
    const turnId = h.store.model.turns[workerId]?.[0]?.id ?? "";
    await waitForEvent(
      h.store,
      "worker.reported",
      (event) => event.workerThreadId === workerId && event.turnId === turnId,
    );
    const dupes = h.store
      .eventsAfter(0)
      .filter(
        (event) =>
          event.type === "worker.reported" &&
          event.workerThreadId === workerId &&
          event.turnId === turnId,
      );
    expect(dupes).toHaveLength(1);
    const coordinator = h.store.model.threads[coordId];
    const queued = coordinator?.queue.length ?? 0;
    const started = h.store.model.turns[coordId]?.length ?? 0;
    expect(queued + started).toBeGreaterThan(0);
  });
});

describe("fleet merge effect", () => {
  it("records merged after the git effect succeeds", async () => {
    const fake = createFakeGit();
    const h = await harness({ git: fake.git });
    const threadId = h.createThread("full", "demo", true);
    await h.runner.idle();
    await waitForEvent(h.store, "thread.worktreeBound", (event) => event.threadId === threadId);
    h.dispatch({ type: "thread.merge", threadId, strategy: "merge" });
    await waitForEvent(
      h.store,
      "thread.mergeChanged",
      (event) => event.threadId === threadId && event.merge.status === "merged",
    );
    expect(h.store.model.threads[threadId]?.merge?.status).toBe("merged");
  });
});

describe("effect runner brain context", () => {
  const recorder = (inputs: TurnInput[]) =>
    scripted("demo", async function* (input) {
      inputs.push(input);
      yield { type: "done", status: "completed", error: null };
    });

  it("puts the brain block before the prompt, keeps the stored prompt, and ends the turn's claims", async () => {
    const inputs: TurnInput[] = [];
    const calls: string[] = [];
    const h = await harness({
      adapters: [recorder(inputs)],
      brain: {
        contextFor: (input) => {
          calls.push(`context ${input.projectId} ${input.role} ${input.prompt}`);
          return "<wooky-brain-context>\nhi\n</wooky-brain-context>";
        },
        turnEnded: (threadId) => calls.push(`ended ${threadId}`),
      },
    });
    const threadId = h.createThread("full");
    await finishedFor(h.store, h.startTurn(threadId, "Fix the build").turnId);
    await h.runner.idle();
    expect(inputs[0]?.prompt).toBe(
      "<wooky-brain-context>\nhi\n</wooky-brain-context>\n\nFix the build",
    );
    expect(h.store.model.turns[threadId]?.[0]?.prompt).toBe("Fix the build");
    expect(calls[0]).toMatch(/^context \S+ undefined Fix the build$/);
    expect(calls.at(-1)).toBe(`ended ${threadId}`);
  });

  it("sends the plain prompt when there is no block, and when the hooks throw", async () => {
    const inputs: TurnInput[] = [];
    const quiet = await harness({
      adapters: [recorder(inputs)],
      brain: { contextFor: () => null, turnEnded: () => {} },
    });
    const first = quiet.createThread("full");
    await finishedFor(quiet.store, quiet.startTurn(first, "plain").turnId);

    const broken = await harness({
      adapters: [recorder(inputs)],
      brain: {
        contextFor: () => {
          throw new Error("brain down");
        },
        turnEnded: () => {
          throw new Error("brain down");
        },
      },
    });
    const second = broken.createThread("full");
    expect(
      await finishedFor(broken.store, broken.startTurn(second, "still plain").turnId),
    ).toMatchObject({
      status: "completed",
    });
    expect(inputs.map((input) => input.prompt)).toEqual(["plain", "still plain"]);
  });
});
