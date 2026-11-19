import { describe, expect, it } from "vitest";
import type { AgeEvent, Command, PendingEvent, ReadModel, Thread } from "@wooky/contracts";
import { applyEvents, emptyReadModel } from "@wooky/domain";
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
    queue: [],
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
      checkpointBefore: "refs/wooky/checkpoints/t1/u1/before",
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

function applyAt(model: ReadModel, events: PendingEvent[], time: string): ReadModel {
  let seq = model.seq;
  return applyEvents(
    model,
    events.map((event) => ({ ...event, seq: ++seq, at: time }) as AgeEvent),
  );
}

function finishAt(
  model: ReadModel,
  turnId: string,
  nativeRef: string | null,
  time: string,
): ReadModel {
  const threadId =
    Object.entries(model.turns).find(([, turns]) =>
      turns.some((turn) => turn.id === turnId),
    )?.[0] ?? "t1";
  return applyAt(
    model,
    [
      {
        type: "turn.finished",
        commandId: null,
        threadId,
        turnId,
        status: "completed",
        checkpointAfter: `refs/wooky/checkpoints/${threadId}/${turnId}/after`,
        changedFiles: [],
        usage: null,
        error: null,
        ...(nativeRef === null ? {} : { nativeRef }),
      },
    ],
    time,
  );
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
    const worktree = { path: "/work/.wooky-worktrees/demo/t1", branch: "wooky/t1" };
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

describe("decide effort and scratch", () => {
  it("records the effort a thread starts with", () => {
    const { events } = accepted(
      run(
        seed(),
        command("thread.create", {
          projectId: "p1",
          provider: "claude",
          model: "opus",
          runtimeMode: "approve",
          isolate: false,
          effort: "medium",
        }),
      ),
    );
    expect(events[0]).toMatchObject({ type: "thread.created", thread: { effort: "medium" } });
  });

  it("changes effort with configure and keeps it when it is not named", () => {
    const first = accepted(
      run(seed(), command("thread.configure", { threadId: "t1", effort: "max" })),
    );
    expect(first.events[0]).toMatchObject({ type: "thread.configured", effort: "max" });
    const model = apply(seed(), first.events);
    expect(model.threads.t1?.effort).toBe("max");
    const second = accepted(
      run(model, command("thread.configure", { threadId: "t1", runtimeMode: "full" })),
    );
    expect(apply(model, second.events).threads.t1?.effort).toBe("max");
  });

  it("turns fast mode and ultracode on and off with configure, and keeps them otherwise", () => {
    const on = accepted(
      run(seed(), command("thread.configure", { threadId: "t1", fastMode: true, ultracode: true })),
    );
    const model = apply(seed(), on.events);
    expect(model.threads.t1).toMatchObject({ fastMode: true, ultracode: true });
    const off = accepted(
      run(model, command("thread.configure", { threadId: "t1", fastMode: false })),
    );
    expect(apply(model, off.events).threads.t1).toMatchObject({ fastMode: false, ultracode: true });
  });

  it("flags a scratch project and leaves ordinary projects unflagged", () => {
    const scratch = accepted(
      run(
        emptyReadModel(),
        command("project.add", { root: "/wooky/scratch", name: "No project", scratch: true }),
      ),
    );
    expect(scratch.events[0]).toMatchObject({ project: { scratch: true } });
    const plain = accepted(run(emptyReadModel(), command("project.add", { root: "/work/x" })));
    expect(plain.events[0]).not.toHaveProperty("project.scratch");
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
    const worktree = { path: "/wt/t1", branch: "wooky/t1" };
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

  it("records interactionMode when the provider can plan", () => {
    const ctx = testContext((provider) => (provider === "demo" ? { planMode: true } : undefined));
    const { events } = accepted(
      decide(seed(), command("thread.configure", { threadId: "t1", interactionMode: "plan" }), ctx),
    );
    expect(events[0]).toMatchObject({
      provider: "demo",
      interactionMode: "plan",
      handoff: false,
    });
  });

  it("rejects plan mode when the provider cannot plan", () => {
    const plan = command("thread.configure", { threadId: "t1", interactionMode: "plan" });
    expect(run(seed(), plan)).toMatchObject({
      code: "bad_request",
      message: "This provider does not support plan mode.",
    });
    const cursor = apply(seed(), [
      {
        type: "thread.configured",
        commandId: "seed",
        threadId: "t1",
        provider: "cursor",
        model: "auto",
        runtimeMode: "full",
        handoff: true,
      },
    ]);
    const ctx = testContext((provider) =>
      provider === "cursor" ? { planMode: false } : { planMode: true },
    );
    expect(decide(cursor, plan, ctx)).toMatchObject({ code: "bad_request" });
  });

  it("rejects a turn that would run in plan mode on a provider that cannot plan", () => {
    const planned = apply(seed({ interactionMode: "plan", provider: "cursor" }), []);
    expect(
      run(planned, command("turn.start", { threadId: "t1", prompt: "Plan it" })),
    ).toMatchObject({ code: "bad_request", message: "This provider does not support plan mode." });
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
      checkpointBefore: "refs/wooky/checkpoints/t1/turn-1/before",
      interactionMode: "default",
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
    const worktree = { path: "/wt/t1", branch: "wooky/t1" };
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
        ref: "refs/wooky/checkpoints/t1/u1/before",
      },
      {
        kind: "session.rewind",
        threadId: "t1",
        turnId: "u1",
        keepNativeRef: null,
        dropTurns: 1,
      },
    ]);
  });

  it("rewinds to the last kept nativeRef and counts every dropped turn", () => {
    const first = finishAt(running(), "u1", "msg-1", "2026-01-01T00:00:00.000Z");
    const second = applyAt(
      first,
      [
        {
          type: "turn.started",
          commandId: "seed",
          threadId: "t1",
          turnId: "u2",
          prompt: "next",
          provider: "demo",
          model: "demo",
          checkpointBefore: "refs/wooky/checkpoints/t1/u2/before",
        },
      ],
      "2026-01-02T00:00:00.000Z",
    );
    const both = finishAt(second, "u2", "msg-2", "2026-01-02T00:00:01.000Z");
    const { effects } = accepted(
      run(both, command("turn.revert", { threadId: "t1", turnId: "u2" })),
    );
    expect(effects[1]).toEqual({
      kind: "session.rewind",
      threadId: "t1",
      turnId: "u2",
      keepNativeRef: "msg-1",
      dropTurns: 1,
    });
    const dropped = accepted(run(both, command("turn.revert", { threadId: "t1", turnId: "u1" })));
    expect(dropped.effects[1]).toMatchObject({ keepNativeRef: null, dropTurns: 2 });
  });
});

describe("decide question.respond", () => {
  const asking = () =>
    apply(running(), [
      {
        type: "question.requested",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        itemId: "q1",
        requestId: "r1",
        questions: [
          { id: "db", question: "Which?", options: [], multiSelect: false, allowCustom: true },
        ],
      },
    ]);

  it("resolves an open question and hands the answers to the runner", () => {
    const cmd = command("question.respond", {
      threadId: "t1",
      requestId: "r1",
      answers: { db: ["SQLite"] },
    });
    const { events, effects } = accepted(run(asking(), cmd));
    expect(events).toMatchObject([
      { type: "question.resolved", turnId: "u1", requestId: "r1", answers: { db: ["SQLite"] } },
    ]);
    expect(effects).toEqual([
      {
        kind: "question.resolve",
        threadId: "t1",
        turnId: "u1",
        requestId: "r1",
        answers: { db: ["SQLite"] },
      },
    ]);
  });

  it("passes a dismissal through as null answers", () => {
    const cmd = command("question.respond", { threadId: "t1", requestId: "r1", answers: null });
    expect(accepted(run(asking(), cmd)).effects).toMatchObject([{ answers: null }]);
  });

  it("rejects an unknown thread or request", () => {
    const answers = { db: ["SQLite"] };
    expect(
      run(asking(), command("question.respond", { threadId: "t9", requestId: "r1", answers })),
    ).toMatchObject({ code: "not_found" });
    expect(
      run(asking(), command("question.respond", { threadId: "t1", requestId: "r9", answers })),
    ).toMatchObject({ code: "not_found" });
  });

  it("rejects a question that was already answered or dismissed", () => {
    const answer = command("question.respond", {
      threadId: "t1",
      requestId: "r1",
      answers: { db: ["SQLite"] },
    });
    const answered = apply(asking(), accepted(run(asking(), answer)).events);
    expect(run(answered, answer)).toMatchObject({ code: "conflict" });

    const dismiss = command("question.respond", { threadId: "t1", requestId: "r1", answers: null });
    const dismissed = apply(asking(), accepted(run(asking(), dismiss)).events);
    expect(run(dismissed, answer)).toMatchObject({ code: "conflict" });
    expect(run(finished(asking()), answer)).toMatchObject({ code: "conflict" });
  });
});

describe("decide question answers", () => {
  const choice = {
    id: "db",
    question: "Which?",
    options: [{ label: "SQLite" }, { label: "Postgres" }],
    multiSelect: false,
    allowCustom: false,
  };
  const asking = () =>
    apply(running(), [
      {
        type: "question.requested",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        itemId: "q1",
        requestId: "r1",
        questions: [choice],
      },
    ]);
  const respond = (answers: Record<string, string[]> | null) =>
    command("question.respond", { threadId: "t1", requestId: "r1", answers });

  it("rejects an empty answer set, an empty list, an unknown id, free text, and extra picks", () => {
    expect(run(asking(), respond({}))).toMatchObject({ code: "bad_request" });
    expect(run(asking(), respond({ db: [] }))).toMatchObject({ code: "bad_request" });
    expect(run(asking(), respond({ other: ["SQLite"] }))).toMatchObject({
      code: "bad_request",
      message: "Unknown question other.",
    });
    expect(run(asking(), respond({ db: ["MySQL"] }))).toMatchObject({
      code: "bad_request",
      message: "That answer is not one of the options.",
    });
    expect(run(asking(), respond({ db: ["SQLite", "Postgres"] }))).toMatchObject({
      code: "bad_request",
      message: "This question accepts one answer.",
    });
  });

  it("accepts one listed option, and free text only when the question allows it", () => {
    expect(accepted(run(asking(), respond({ db: ["SQLite"] }))).events).toMatchObject([
      { answers: { db: ["SQLite"] } },
    ]);
    const custom = apply(running(), [
      {
        type: "question.requested",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        itemId: "q1",
        requestId: "r1",
        questions: [{ ...choice, allowCustom: true, multiSelect: true }],
      },
    ]);
    expect(
      accepted(run(custom, respond({ db: ["SQLite", "Somewhere else"] }))).effects,
    ).toMatchObject([{ answers: { db: ["SQLite", "Somewhere else"] } }]);
  });
});

describe("decide queue commands", () => {
  function queued(model: ReadModel = running()): ReadModel {
    return apply(model, [
      {
        type: "queue.added",
        commandId: "seed",
        threadId: "t1",
        item: { id: "q1", prompt: "follow up", queuedAt: at },
      },
    ]);
  }

  it("queues a prompt while a turn is running and still rejects by default", () => {
    expect(run(running(), command("turn.start", { threadId: "t1", prompt: "x" }))).toMatchObject({
      code: "conflict",
    });
    const cmd = command("turn.start", { threadId: "t1", prompt: "later", whenBusy: "queue" });
    const { events, effects } = accepted(run(running(), cmd));
    expect(events).toEqual([
      {
        type: "queue.added",
        commandId: cmd.commandId,
        threadId: "t1",
        item: { id: "queue-1", prompt: "later", queuedAt: at },
      },
    ]);
    expect(effects).toEqual([]);
  });

  it("starts a turn when whenBusy is queue but the thread is idle", () => {
    const { events } = accepted(
      run(seed(), command("turn.start", { threadId: "t1", prompt: "now", whenBusy: "queue" })),
    );
    expect(events.map((event) => event.type)).toEqual(["thread.renamed", "turn.started"]);
  });

  it("removes a queued prompt", () => {
    const cmd = command("queue.remove", { threadId: "t1", queueId: "q1" });
    expect(accepted(run(queued(), cmd)).events).toMatchObject([
      { type: "queue.removed", queueId: "q1", reason: "removed" },
    ]);
    expect(run(seed(), cmd)).toMatchObject({ code: "not_found" });
  });

  it("promotes the queued prompt only while the thread is idle", () => {
    const cmd = command("queue.promote", { threadId: "t1", queueId: "q1" });
    expect(run(queued(), cmd)).toMatchObject({ code: "conflict" });
    const idle = queued(finished(running({ title: "Mine" })));
    const { events, effects } = accepted(run(idle, cmd));
    expect(events).toMatchObject([
      { type: "queue.removed", queueId: "q1", reason: "started" },
      {
        type: "turn.started",
        prompt: "follow up",
        fromQueueId: "q1",
        interactionMode: "default",
      },
    ]);
    expect(effects).toEqual([{ kind: "turn.run", threadId: "t1", turnId: "turn-1" }]);
    expect(run(seed(), cmd)).toMatchObject({ code: "not_found" });
  });
});

describe("decide turn.revert restoreFiles", () => {
  it("rewinds the conversation without restoring files", () => {
    const cmd = command("turn.revert", { threadId: "t1", turnId: "u1", restoreFiles: false });
    const { events, effects } = accepted(run(finished(running()), cmd));
    expect(events).toEqual([
      {
        type: "turn.reverted",
        commandId: cmd.commandId,
        threadId: "t1",
        turnId: "u1",
        restoredFiles: false,
      },
    ]);
    expect(effects).toEqual([
      {
        kind: "session.rewind",
        threadId: "t1",
        turnId: "u1",
        keepNativeRef: null,
        dropTurns: 1,
      },
    ]);
  });

  it("still restores files when restoreFiles is true", () => {
    const cmd = command("turn.revert", { threadId: "t1", turnId: "u1", restoreFiles: true });
    expect(accepted(run(finished(running()), cmd)).effects).toMatchObject([
      { kind: "checkpoint.restore" },
      { kind: "session.rewind" },
    ]);
  });

  it("rejects a file restore when another root thread is running or started later", () => {
    const shared = apply(finished(running()), [
      { type: "thread.created", commandId: "seed", thread: thread({ id: "t2", title: "Other" }) },
    ]);
    const later = applyAt(
      shared,
      [
        {
          type: "turn.started",
          commandId: "seed",
          threadId: "t2",
          turnId: "u2",
          prompt: "later",
          provider: "demo",
          model: "demo",
          checkpointBefore: "refs/wooky/checkpoints/t2/u2/before",
        },
      ],
      "2026-01-02T00:00:00.000Z",
    );
    const idleLater = finishAt(later, "u2", null, "2026-01-02T00:00:01.000Z");
    const fileRestore = command("turn.revert", { threadId: "t1", turnId: "u1" });
    expect(run(idleLater, fileRestore)).toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Conversation-only revert is available."),
    });

    const busy = apply(shared, [
      {
        type: "turn.started",
        commandId: "seed",
        threadId: "t2",
        turnId: "u2",
        prompt: "now",
        provider: "demo",
        model: "demo",
        checkpointBefore: null,
      },
    ]);
    expect(run(busy, fileRestore).ok).toBe(false);

    const conversation = command("turn.revert", {
      threadId: "t1",
      turnId: "u1",
      restoreFiles: false,
    });
    expect(accepted(run(idleLater, conversation)).effects).toEqual([
      {
        kind: "session.rewind",
        threadId: "t1",
        turnId: "u1",
        keepNativeRef: null,
        dropTurns: 1,
      },
    ]);
  });

  it("restores files when the other thread's turn is older, or this thread has its own worktree", () => {
    const older = applyAt(
      seed(),
      [
        { type: "thread.created", commandId: "seed", thread: thread({ id: "t2", title: "Other" }) },
        {
          type: "turn.started",
          commandId: "seed",
          threadId: "t2",
          turnId: "u2",
          prompt: "earlier",
          provider: "demo",
          model: "demo",
          checkpointBefore: "refs/wooky/checkpoints/t2/u2/before",
        },
      ],
      "2025-12-01T00:00:00.000Z",
    );
    const withOlder = finishAt(older, "u2", null, "2025-12-01T00:00:01.000Z");
    const mine = applyAt(
      withOlder,
      [
        {
          type: "turn.started",
          commandId: "seed",
          threadId: "t1",
          turnId: "u1",
          prompt: "hi",
          provider: "demo",
          model: "demo",
          checkpointBefore: "refs/wooky/checkpoints/t1/u1/before",
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    const ready = finishAt(mine, "u1", null, "2026-01-01T00:00:01.000Z");
    expect(
      accepted(run(ready, command("turn.revert", { threadId: "t1", turnId: "u1" }))).effects[0],
    ).toMatchObject({ kind: "checkpoint.restore" });

    const own = finished(running({ worktree: { path: "/wt/t1", branch: "wooky/t1" } }));
    const crowded = applyAt(
      own,
      [
        { type: "thread.created", commandId: "seed", thread: thread({ id: "t2", title: "Other" }) },
        {
          type: "turn.started",
          commandId: "seed",
          threadId: "t2",
          turnId: "u2",
          prompt: "later",
          provider: "demo",
          model: "demo",
          checkpointBefore: null,
        },
      ],
      "2026-02-01T00:00:00.000Z",
    );
    expect(
      accepted(run(crowded, command("turn.revert", { threadId: "t1", turnId: "u1" }))).effects[0],
    ).toMatchObject({ kind: "checkpoint.restore", cwd: "/wt/t1" });
  });
});

describe("decide thread.failover", () => {
  const failure = { kind: "rate_limit" as const, message: "slow down" };

  it("rejects missing thread, busy thread, same target, and unknown provider", () => {
    expect(
      run(
        seed(),
        command("thread.failover", {
          threadId: "missing",
          to: { provider: "codex", model: "gpt-6.1-sol" },
          failure,
          retryPrompt: "again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "not_found" });

    expect(
      run(
        running({ provider: "claude", model: "sonnet" }),
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "codex", model: "gpt-6.1-sol" },
          failure,
          retryPrompt: "again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "conflict" });

    expect(
      run(
        seed({ provider: "claude", model: "sonnet" }),
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "claude", model: "sonnet" },
          failure,
          retryPrompt: "again",
        }),
      ),
    ).toMatchObject({ ok: false, code: "bad_request" });

    const ctx = testContext();
    ctx.hasProvider = () => false;
    expect(
      decide(
        seed(),
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "codex", model: "gpt-6.1-sol" },
          failure,
          retryPrompt: "again",
        }),
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("cools down, reconfigures, records failedOver, and starts a retry turn", () => {
    const model = apply(seed({ provider: "claude", model: "sonnet", status: "error" }), [
      {
        type: "turn.started",
        commandId: "seed",
        threadId: "t1",
        turnId: "u-fail",
        prompt: "Ship it",
        provider: "claude",
        model: "sonnet",
        checkpointBefore: "refs/wooky/checkpoints/t1/u-fail/before",
      },
      {
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u-fail",
        status: "failed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: "rate",
        failure,
      },
    ]);
    const decision = accepted(
      run(
        model,
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "codex", model: "gpt-6.1-sol" },
          failure,
          retryPrompt: "Ship it",
          from: { provider: "claude", model: "sonnet" },
          failedTurnId: "u-fail",
        }),
      ),
    );
    expect(decision.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "provider.cooledDown",
        "thread.configured",
        "thread.failedOver",
        "turn.started",
      ]),
    );
    expect(decision.events.find((event) => event.type === "thread.configured")).toMatchObject({
      type: "thread.configured",
      provider: "codex",
      model: "gpt-6.1-sol",
      handoff: true,
    });
    expect(decision.events.find((event) => event.type === "thread.failedOver")).toMatchObject({
      switches: 1,
      from: { provider: "claude", model: "sonnet" },
    });
    expect(decision.events.find((event) => event.type === "turn.started")).toMatchObject({
      origin: {
        kind: "failover",
        from: { provider: "claude", model: "sonnet" },
        to: { provider: "codex", model: "gpt-6.1-sol" },
        failure,
        switches: 1,
      },
    });
    expect(decision.effects).toEqual([{ kind: "turn.run", threadId: "t1", turnId: "turn-1" }]);
    const events = decision.events as PendingEvent[];
    const next = apply(model, events);
    expect(next.threads.t1?.provider).toBe("codex");
    expect(next.turns.t1?.at(-1)?.prompt).toBe("Ship it");
    expect(next.turns.t1?.at(-1)?.origin?.kind).toBe("failover");
  });

  it("keeps failover.original across chained switches", () => {
    const afterFirst = apply(seed({ provider: "claude", model: "sonnet" }), [
      {
        type: "thread.failedOver",
        commandId: "c0",
        threadId: "t1",
        from: { provider: "claude", model: "sonnet" },
        to: { provider: "codex", model: "gpt-6.1-sol" },
        failure,
        switches: 1,
      },
    ]);
    const switched = apply(afterFirst, [
      {
        type: "thread.configured",
        commandId: "c0",
        threadId: "t1",
        provider: "codex",
        model: "gpt-6.1-sol",
        runtimeMode: "approve",
        handoff: true,
      },
    ]);
    const decision = accepted(
      run(
        switched,
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "cursor", model: "auto" },
          failure,
          retryPrompt: "retry",
        }),
      ),
    );
    const failedOver = decision.events.find((event) => event.type === "thread.failedOver");
    expect(failedOver).toMatchObject({
      switches: 2,
      from: { provider: "codex", model: "gpt-6.1-sol" },
    });
    const next = apply(switched, decision.events as PendingEvent[]);
    expect(next.threads.t1?.failover?.original).toEqual({ provider: "claude", model: "sonnet" });
  });

  it("records cooldown when beginTurn rejects plan mode on the target", () => {
    const model = apply(
      seed({ provider: "claude", model: "sonnet", status: "error", interactionMode: "plan" }),
      [
        {
          type: "turn.started",
          commandId: "seed",
          threadId: "t1",
          turnId: "u-fail",
          prompt: "plan",
          provider: "claude",
          model: "sonnet",
          checkpointBefore: null,
          interactionMode: "plan",
        },
        {
          type: "turn.finished",
          commandId: null,
          threadId: "t1",
          turnId: "u-fail",
          status: "failed",
          checkpointAfter: null,
          changedFiles: [],
          usage: null,
          error: "rate",
          failure,
        },
      ],
    );
    const ctx = testContext((provider) => (provider === "claude" ? { planMode: true } : undefined));
    const decision = accepted(
      decide(
        model,
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "codex", model: "gpt-6.1-sol" },
          failure,
          retryPrompt: "plan",
          from: { provider: "claude", model: "sonnet" },
          failedTurnId: "u-fail",
        }),
        ctx,
      ),
    );
    expect(decision.events.map((event) => event.type)).toEqual(["provider.cooledDown"]);
    expect(decision.effects).toEqual([]);
  });

  it("clears expired cooldowns lazily on failover", () => {
    const cooled = apply(seed(), [
      {
        type: "provider.cooledDown",
        commandId: null,
        key: "claude",
        until: "2025-12-31T00:00:00.000Z",
        reason: "rate_limit",
      },
    ]);
    const decision = accepted(
      run(
        cooled,
        command("thread.failover", {
          threadId: "t1",
          to: { provider: "codex", model: "gpt-6.1-sol" },
          failure,
          retryPrompt: "again",
        }),
      ),
    );
    expect(decision.events.some((event) => event.type === "provider.cooldownCleared")).toBe(true);
  });
});

describe("decide turn.start switch-back", () => {
  it("restores the original model before starting when cooldowns have lifted", () => {
    const failoverThread = thread({
      provider: "cursor",
      model: "auto",
      failover: {
        original: { provider: "claude", model: "sonnet" },
        switchedAt: at,
        reason: "rate_limit",
        switches: 1,
      },
    });
    const model = apply(seed(failoverThread), []);
    const decision = accepted(
      decide(model, command("turn.start", { threadId: "t1", prompt: "x" }), testContext()),
    );
    expect(decision.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["thread.configured", "thread.failoverRestored", "turn.started"]),
    );
    expect(decision.events[0]).toMatchObject({
      provider: "claude",
      model: "sonnet",
      handoff: true,
    });
    expect(decision.events.find((event) => event.type === "turn.started")).toMatchObject({
      origin: {
        kind: "restore",
        from: { provider: "cursor", model: "auto" },
        to: { provider: "claude", model: "sonnet" },
      },
    });
  });

  it("sets no origin on an ordinary turn", () => {
    const decision = accepted(
      decide(
        apply(seed(thread({ provider: "claude", model: "sonnet" })), []),
        command("turn.start", { threadId: "t1", prompt: "x" }),
        testContext(),
      ),
    );
    const started = decision.events.find((event) => event.type === "turn.started");
    expect(started).toBeDefined();
    expect(started).not.toHaveProperty("origin");
  });
});
