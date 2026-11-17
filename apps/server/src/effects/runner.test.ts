import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgeEvent, ProviderEvent, ProviderKind, RuntimeMode, Thread } from "@age/contracts";
import { createNoopGitService } from "../git/noop.ts";
import type { GitService } from "../git/types.ts";
import { createDispatcher } from "../orchestrator/dispatcher.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { createProviderRegistry } from "../providers/registry.ts";
import type { ProviderAdapter, TurnInput } from "../providers/types.ts";
import { openEventStore, type EventStore } from "../store/event-store.ts";
import { createFakeGit, tempDir, testContext, waitForEvent } from "../testing.ts";
import { createEffectRunner, type EffectRunner } from "./runner.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function scripted(
  kind: ProviderKind,
  run: (input: TurnInput) => AsyncIterable<ProviderEvent>,
): ProviderAdapter {
  return {
    kind,
    probe: async () => {
      throw new Error("not probed in tests");
    },
    runTurn: run,
  };
}

async function harness(
  options: {
    adapters?: ProviderAdapter[];
    git?: GitService;
    wrapStore?: (store: EventStore) => EventStore;
  } = {},
) {
  const home = await tempDir("runner");
  const root = await tempDir("project");
  const ctx = testContext();
  const fake = createFakeGit();
  const opened = openEventStore(home, ctx.now);
  const store = options.wrapStore?.(opened) ?? opened;
  const providers = createProviderRegistry(options.adapters ?? [createDemoAdapter({ stepMs: 0 })]);
  const runner = createEffectRunner({
    store,
    providers,
    git: options.git ?? fake.git,
    newId: ctx.newId,
  });
  const dispatcher = createDispatcher({ store, runner, ctx });
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
        project: { id: "p1", name: "p", root, createdAt: at },
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
  const runner = createEffectRunner({
    store,
    providers: createProviderRegistry(adapters ?? [createDemoAdapter({ stepMs: 0 })]),
    git,
    newId: ctx.newId,
  });
  runner.recover();
  return { store, runner };
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
      checkpointAfter: `refs/age/checkpoints/${threadId}/${turnId}/after`,
      changedFiles: ["AGE_DEMO.md"],
      usage: { inputTokens: "Add a line".length, outputTokens: 12 },
      error: null,
    });
    expect(h.calls).toEqual([
      `capture refs/age/checkpoints/${threadId}/${turnId}/before`,
      `capture refs/age/checkpoints/${threadId}/${turnId}/after`,
      `diff refs/age/checkpoints/${threadId}/${turnId}/before refs/age/checkpoints/${threadId}/${turnId}/after`,
    ]);
    expect(await readFile(join(h.root, "AGE_DEMO.md"), "utf8")).toBe("- Add a line\n");
    expect(h.store.model.threads[threadId]).toMatchObject({
      status: "idle",
      providerSessionId: `demo-${threadId}`,
    });
    const answer = h.store.model.turns[threadId]?.[0]?.items.find(
      (item) => item.kind === "message",
    );
    expect(answer).toMatchObject({ text: "Done. I added a line to AGE_DEMO.md and ran echo ok." });
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
    expect(await readFile(join(h.root, "AGE_DEMO.md"), "utf8")).toBe("- Edit please\n");
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
    await expect(readFile(join(h.root, "AGE_DEMO.md"), "utf8")).rejects.toThrow(/ENOENT/);
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
    expect(h.calls).toContain(`restore refs/age/checkpoints/${threadId}/${turnId}/before`);
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
          project: { id: "p1", name: "p", root: "/p", createdAt: at },
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
      checkpointBefore: "refs/age/checkpoints/t1/u1/before",
    };
    first.commit({ commandId: "c1", events: [turn], effects: [] });
    first.appendInternal([
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "completed",
        checkpointAfter: "refs/age/checkpoints/t1/u1/after",
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
          ref: "refs/age/checkpoints/t1/u1/before",
        },
      ],
    });
    first.close();

    const fake = createFakeGit();
    const second = restart(home, fake.git);
    await second.runner.idle();
    expect(fake.calls).toEqual(["restore refs/age/checkpoints/t1/u1/before"]);
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
          checkpointBefore: "refs/age/checkpoints/t1/u1/before",
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
          ref: "refs/age/checkpoints/t1/u1/before",
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
    const worktree = { path: join(root, ".worktrees", "t1"), branch: "age/t1" };
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
