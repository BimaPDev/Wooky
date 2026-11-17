import { describe, expect, it } from "vitest";
import type { AgeEvent, Command, PendingEvent, ReadModel, Thread } from "@age/contracts";
import { applyEvents, emptyReadModel } from "@age/domain";
import { testContext } from "../testing.ts";
import { decide, type Decision } from "./decide.ts";

const at = "2026-01-01T00:00:00.000Z";
let commandCounter = 0;

function command<T extends Command["type"]>(
  type: T,
  fields: Omit<Extract<Command, { type: T }>, "type" | "commandId">,
): Command {
  return { type, commandId: `cmd-${++commandCounter}`, ...fields } as unknown as Command;
}

function apply(model: ReadModel, events: PendingEvent[]): ReadModel {
  let seq = model.seq;
  return applyEvents(
    model,
    events.map((event) => ({ ...event, seq: ++seq, at }) as AgeEvent),
  );
}

function accepted(decision: Decision) {
  if (!decision.ok) throw new Error(`expected accept, got ${decision.code}: ${decision.message}`);
  return decision;
}

function thread(fields: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    title: "New thread",
    provider: "demo",
    model: "demo",
    runtimeMode: "approve",
    worktree: null,
    providerSessionId: null,
    status: "idle",
    createdAt: at,
    updatedAt: at,
    ...fields,
  };
}

function seed(threadFields: Partial<Thread> = {}): ReadModel {
  return apply(emptyReadModel(), [
    {
      type: "project.added",
      commandId: "seed",
      project: { id: "p1", name: "demo", root: "/work/demo", createdAt: at },
    },
    { type: "thread.created", commandId: "seed", thread: thread(threadFields) },
  ]);
}

function running(threadFields: Partial<Thread> = {}): ReadModel {
  return apply(seed(threadFields), [
    {
      type: "turn.started",
      commandId: "seed",
      threadId: "t1",
      turnId: "u1",
      prompt: "hi",
      provider: "demo",
      model: "demo",
      checkpointBefore: "refs/age/checkpoints/t1/u1/before",
    },
  ]);
}

function finished(model: ReadModel): ReadModel {
  return apply(model, [
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
}

const run = (model: ReadModel, cmd: Command) => decide(model, cmd, testContext());

describe("decide project.add", () => {
  it("adds a project named after its directory", () => {
    const cmd = command("project.add", { root: "/work/app" });
    const { events, effects } = accepted(run(emptyReadModel(), cmd));
    expect(events).toEqual([
      {
        type: "project.added",
        commandId: cmd.commandId,
        project: { id: "project-1", name: "app", root: "/work/app", createdAt: at },
      },
    ]);
    expect(effects).toEqual([]);
  });

  it("normalizes the root and keeps an explicit name", () => {
    const { events } = accepted(
      run(emptyReadModel(), command("project.add", { root: "/work/x/../app/", name: "App" })),
    );
    expect(events[0]).toMatchObject({ project: { root: "/work/app", name: "App" } });
  });

  it("rejects a relative root", () => {
    expect(run(emptyReadModel(), command("project.add", { root: "work/app" }))).toMatchObject({
      ok: false,
      code: "bad_request",
    });
  });

  it("rejects a duplicate root", () => {
    expect(run(seed(), command("project.add", { root: "/work/demo/" }))).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });
});

describe("decide project.remove", () => {
  it("rejects an unknown project", () => {
    expect(run(seed(), command("project.remove", { projectId: "nope" }))).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rejects while a thread is running", () => {
    expect(run(running(), command("project.remove", { projectId: "p1" }))).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("removes the project and the worktrees of its isolated threads", () => {
    const worktree = { path: "/work/.age-worktrees/demo/t1", branch: "age/t1" };
    const { events, effects } = accepted(
      run(seed({ worktree }), command("project.remove", { projectId: "p1" })),
    );
    expect(events).toMatchObject([{ type: "project.removed", projectId: "p1" }]);
    expect(effects).toEqual([
      { kind: "worktree.remove", threadId: "t1", projectRoot: "/work/demo", worktree },
    ]);
  });
});

describe("decide thread.create", () => {
  const create = (fields: { projectId?: string; isolate?: boolean; title?: string } = {}) =>
    command("thread.create", {
      projectId: fields.projectId ?? "p1",
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: fields.isolate ?? false,
      ...(fields.title ? { title: fields.title } : {}),
    });

  it("rejects an unknown project", () => {
    expect(run(seed(), create({ projectId: "nope" }))).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("creates an idle thread without a worktree", () => {
    const { events, effects } = accepted(run(seed(), create()));
    expect(events[0]).toMatchObject({
      type: "thread.created",
      thread: { id: "thread-1", title: "New thread", status: "idle", worktree: null },
    });
    expect(effects).toEqual([]);
  });

  it("asks for a worktree when isolated", () => {
    const { effects } = accepted(run(seed(), create({ isolate: true, title: "Spike" })));
    expect(effects).toEqual([
      { kind: "worktree.create", threadId: "thread-1", projectRoot: "/work/demo" },
    ]);
  });
});

describe("decide thread.rename / thread.remove", () => {
  it("renames a thread", () => {
    const { events } = accepted(
      run(seed(), command("thread.rename", { threadId: "t1", title: " X " })),
    );
    expect(events).toMatchObject([{ type: "thread.renamed", threadId: "t1", title: "X" }]);
  });

  it("rejects renaming an unknown thread or to a blank title", () => {
    expect(run(seed(), command("thread.rename", { threadId: "nope", title: "X" }))).toMatchObject({
      code: "not_found",
    });
    expect(run(seed(), command("thread.rename", { threadId: "t1", title: "  " }))).toMatchObject({
      code: "bad_request",
    });
  });

  it("rejects removing an unknown or running thread", () => {
    expect(run(seed(), command("thread.remove", { threadId: "nope" }))).toMatchObject({
      code: "not_found",
    });
    expect(run(running(), command("thread.remove", { threadId: "t1" }))).toMatchObject({
      code: "conflict",
    });
  });

  it("removes an isolated thread together with its worktree", () => {
    const worktree = { path: "/wt/t1", branch: "age/t1" };
    const { events, effects } = accepted(
      run(seed({ worktree }), command("thread.remove", { threadId: "t1" })),
    );
    expect(events).toMatchObject([{ type: "thread.removed", threadId: "t1" }]);
    expect(effects).toMatchObject([{ kind: "worktree.remove", worktree }]);
  });
});

describe("decide thread.configure", () => {
  it("rejects while running", () => {
    expect(
      run(running(), command("thread.configure", { threadId: "t1", model: "x" })),
    ).toMatchObject({ code: "conflict" });
  });

  it("hands off when the provider changes", () => {
    const { events } = accepted(
      run(seed(), command("thread.configure", { threadId: "t1", provider: "codex", model: "gpt" })),
    );
    expect(events[0]).toMatchObject({
      provider: "codex",
      model: "gpt",
      runtimeMode: "approve",
      handoff: true,
    });
  });

  it("does not hand off when only the mode changes", () => {
    const { events } = accepted(
      run(seed(), command("thread.configure", { threadId: "t1", runtimeMode: "full" })),
    );
    expect(events[0]).toMatchObject({ provider: "demo", runtimeMode: "full", handoff: false });
  });
});

describe("decide turn.start", () => {
  it("rejects an unknown thread and a running thread", () => {
    expect(run(seed(), command("turn.start", { threadId: "nope", prompt: "x" }))).toMatchObject({
      code: "not_found",
    });
    expect(run(running(), command("turn.start", { threadId: "t1", prompt: "x" }))).toMatchObject({
      code: "conflict",
    });
  });

  it("starts a turn with a deterministic checkpoint and titles the thread", () => {
    const prompt = `${"Refactor the event store so commits are atomic ".repeat(3)}\nsecond line`;
    const cmd = command("turn.start", { threadId: "t1", prompt });
    const { events, effects } = accepted(run(seed(), cmd));
    expect(events).toHaveLength(2);
    const [renamed, started] = events;
    expect(renamed).toMatchObject({ type: "thread.renamed", commandId: cmd.commandId });
    const title = renamed?.type === "thread.renamed" ? renamed.title : "";
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).not.toContain("\n");
    expect(started).toEqual({
      type: "turn.started",
      commandId: cmd.commandId,
      threadId: "t1",
      turnId: "turn-1",
      prompt,
      provider: "demo",
      model: "demo",
      checkpointBefore: "refs/age/checkpoints/t1/turn-1/before",
    });
    expect(effects).toEqual([{ kind: "turn.run", threadId: "t1", turnId: "turn-1" }]);
  });

  it("keeps a custom title and does not retitle on later turns", () => {
    const custom = accepted(
      run(seed({ title: "Mine" }), command("turn.start", { threadId: "t1", prompt: "x" })),
    );
    expect(custom.events.map((event) => event.type)).toEqual(["turn.started"]);
    const later = accepted(
      run(finished(running()), command("turn.start", { threadId: "t1", prompt: "x" })),
    );
    expect(later.events.map((event) => event.type)).toEqual(["turn.started"]);
  });

  it("allows a new turn after a failed one", () => {
    const failed = apply(running(), [
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "failed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: "boom",
      },
    ]);
    expect(failed.threads.t1?.status).toBe("error");
    expect(run(failed, command("turn.start", { threadId: "t1", prompt: "again" })).ok).toBe(true);
  });
});

describe("decide turn.interrupt", () => {
  it("rejects when nothing runs", () => {
    expect(run(seed(), command("turn.interrupt", { threadId: "t1" }))).toMatchObject({
      code: "conflict",
    });
  });

  it("asks the runner to abort the active turn", () => {
    const { events, effects } = accepted(
      run(running(), command("turn.interrupt", { threadId: "t1" })),
    );
    expect(events).toEqual([]);
    expect(effects).toEqual([{ kind: "turn.interrupt", threadId: "t1", turnId: "u1" }]);
  });
});

describe("decide approval.respond", () => {
  const waiting = () =>
    apply(running(), [
      {
        type: "turn.itemUpserted",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        item: {
          kind: "approval",
          id: "a1",
          requestId: "r1",
          tool: "edit",
          title: "Edit",
          detail: "",
          decision: null,
        },
      },
      {
        type: "approval.requested",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        itemId: "a1",
        requestId: "r1",
      },
    ]);

  it("rejects an unknown request", () => {
    const cmd = command("approval.respond", { threadId: "t1", requestId: "r9", decision: "allow" });
    expect(run(waiting(), cmd)).toMatchObject({ code: "not_found" });
  });

  it("rejects a request that was already answered", () => {
    const cmd = command("approval.respond", { threadId: "t1", requestId: "r1", decision: "allow" });
    const answered = apply(waiting(), accepted(run(waiting(), cmd)).events);
    expect(run(answered, cmd)).toMatchObject({ code: "not_found" });
  });

  it("resolves a pending approval", () => {
    const cmd = command("approval.respond", { threadId: "t1", requestId: "r1", decision: "deny" });
    const { events, effects } = accepted(run(waiting(), cmd));
    expect(events).toMatchObject([
      { type: "approval.resolved", turnId: "u1", requestId: "r1", decision: "deny" },
    ]);
    expect(effects).toEqual([
      { kind: "approval.resolve", threadId: "t1", turnId: "u1", requestId: "r1", decision: "deny" },
    ]);
  });
});

describe("decide turn.revert", () => {
  it("rejects an unknown turn and a running thread", () => {
    expect(
      run(finished(running()), command("turn.revert", { threadId: "t1", turnId: "nope" })),
    ).toMatchObject({
      code: "not_found",
    });
    expect(run(running(), command("turn.revert", { threadId: "t1", turnId: "u1" }))).toMatchObject({
      code: "conflict",
    });
  });

  it("restores the checkpoint in the thread's worktree", () => {
    const worktree = { path: "/wt/t1", branch: "age/t1" };
    const { events, effects } = accepted(
      run(
        finished(running({ worktree })),
        command("turn.revert", { threadId: "t1", turnId: "u1" }),
      ),
    );
    expect(events).toEqual([]);
    expect(effects).toEqual([
      {
        kind: "checkpoint.restore",
        threadId: "t1",
        turnId: "u1",
        cwd: "/wt/t1",
        ref: "refs/age/checkpoints/t1/u1/before",
      },
    ]);
  });
});
