import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgeEvent, ProviderEvent, ProviderKind, RuntimeMode } from "@age/contracts";
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

async function harness(options: { adapters?: ProviderAdapter[]; git?: GitService } = {}) {
  const home = await tempDir("runner");
  const root = await tempDir("project");
  const ctx = testContext();
  const fake = createFakeGit();
  const store = openEventStore(home, ctx.now);
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
    store.close();
  });

  let commands = 0;
  const dispatch = (command: Record<string, unknown>) =>
    dispatcher.dispatch({ commandId: `cmd-${++commands}`, ...command });

  dispatch({ type: "project.add", root });
  const projectId = Object.keys(store.model.projects)[0] ?? "";

  const createThread = (runtimeMode: RuntimeMode, provider: ProviderKind = "demo") => {
    const { seq } = dispatch({
      type: "thread.create",
      projectId,
      provider,
      model: provider,
      runtimeMode,
      isolate: false,
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
    const at = ctx.now();
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
});
