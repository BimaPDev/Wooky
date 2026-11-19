import { describe, expect, it } from "vitest";
import {
  FLEET_LIMITS,
  type Command,
  type PendingEvent,
  type ReadModel,
  type Thread,
} from "@wooky/contracts";
import { applyEvents, emptyReadModel, fleetRows } from "@wooky/domain";
import { testContext } from "../testing.ts";
import { decide } from "./decide.ts";

const at = "2026-01-01T00:00:00.000Z";
let counter = 0;

function cmd<T extends Command["type"]>(
  type: T,
  fields: Omit<Extract<Command, { type: T }>, "type" | "commandId">,
): Command {
  return { type, commandId: `fleet-${++counter}`, ...fields } as unknown as Command;
}

function thread(fields: Partial<Thread> = {}): Thread {
  return {
    id: "coord",
    projectId: "p1",
    title: "Coordinator",
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

function base(fields: Partial<Thread> = {}): ReadModel {
  return applyEvents(emptyReadModel(), [
    {
      seq: 1,
      at,
      type: "project.added",
      commandId: "seed",
      project: { id: "p1", name: "demo", root: "/work/demo", createdAt: at },
    },
    {
      seq: 2,
      at,
      type: "thread.created",
      commandId: "seed",
      thread: thread(fields),
    },
  ]);
}

describe("fleet decide", () => {
  it("spawns a worker with group, worktree effect, and first turn", () => {
    const decision = decide(
      base(),
      cmd("thread.spawn", {
        parentThreadId: "coord",
        provider: "demo",
        model: "demo",
        prompt: "Do the thing",
      }),
      testContext(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.events.map((event) => event.type)).toEqual([
      "group.created",
      "thread.spawned",
      "turn.started",
    ]);
    expect(decision.effects).toEqual(
      expect.arrayContaining([
        { kind: "worktree.create", threadId: expect.any(String), projectRoot: "/work/demo" },
        { kind: "turn.run", threadId: expect.any(String), turnId: expect.any(String) },
      ]),
    );
  });

  it("rejects spawn from a worker", () => {
    const model = applyEvents(base(), [
      {
        seq: 3,
        at,
        type: "thread.spawned",
        commandId: "x",
        parentThreadId: "coord",
        thread: {
          ...thread({ id: "w1", role: "worker", parentThreadId: "coord", isolate: true }),
        },
      },
    ]);
    const decision = decide(
      model,
      cmd("thread.spawn", {
        parentThreadId: "w1",
        provider: "demo",
        model: "demo",
        prompt: "nope",
      }),
      testContext(),
    );
    expect(decision).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("rejects spawn when live workers are at the cap", () => {
    let model = base({ role: "coordinator" });
    const events: PendingEvent[] = [];
    let seq = model.seq;
    for (let i = 0; i < FLEET_LIMITS.maxLiveWorkers; i++) {
      const workerId = `w${i}`;
      events.push({
        commandId: "seed",
        type: "thread.spawned",
        parentThreadId: "coord",
        thread: {
          ...thread({
            id: workerId,
            role: "worker",
            parentThreadId: "coord",
            isolate: true,
            status: "idle",
          }),
        },
      } as PendingEvent);
    }
    model = applyEvents(
      model,
      events.map((event) => ({ ...event, seq: ++seq, at })),
    );
    const decision = decide(
      model,
      cmd("thread.spawn", {
        parentThreadId: "coord",
        provider: "demo",
        model: "demo",
        prompt: "one more",
      }),
      testContext(),
    );
    expect(decision).toMatchObject({ ok: false, code: "bad_request" });
  });

  it("starts a fan-out group", () => {
    const decision = decide(
      base(),
      cmd("fanout.start", {
        projectId: "p1",
        prompt: "Try all",
        targets: [
          { provider: "demo", model: "demo" },
          { provider: "demo", model: "demo" },
        ],
        runtimeMode: "full",
      }),
      testContext(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.events[0]?.type).toBe("group.created");
    expect(decision.events.filter((event) => event.type === "thread.created")).toHaveLength(2);
  });

  it("picks a fan-out winner", () => {
    const model = applyEvents(base(), [
      {
        seq: 3,
        at,
        type: "group.created",
        commandId: "g",
        group: {
          id: "g1",
          projectId: "p1",
          kind: "fanout",
          prompt: "x",
          threadIds: ["a", "b"],
          createdAt: at,
        },
      },
      {
        seq: 4,
        at,
        type: "thread.created",
        commandId: "g",
        thread: thread({
          id: "b",
          groupId: "g1",
          role: "worker",
          worktree: { path: "/work/demo/.wt/b", branch: "age/b" },
        }),
      },
    ]);
    const decision = decide(
      model,
      cmd("fanout.pick", { groupId: "g1", threadId: "b" }),
      testContext(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.events[0]).toMatchObject({ type: "group.winnerPicked", threadId: "b" });
  });

  it("rejects merge without a worktree and while busy", () => {
    const withTree = applyEvents(base(), [
      {
        seq: 3,
        at,
        type: "thread.worktreeBound",
        commandId: null,
        threadId: "coord",
        worktree: { path: "/work/demo/.wt", branch: "age/coord" },
      },
    ]);
    expect(
      decide(
        withTree,
        cmd("thread.merge", { threadId: "coord", strategy: "merge" }),
        testContext(),
      ),
    ).toMatchObject({ ok: true });

    expect(
      decide(base(), cmd("thread.merge", { threadId: "coord", strategy: "merge" }), testContext()),
    ).toMatchObject({ ok: false });

    const running = applyEvents(withTree, [
      {
        seq: 4,
        at,
        type: "turn.started",
        commandId: "r",
        threadId: "coord",
        turnId: "u1",
        prompt: "x",
        provider: "demo",
        model: "demo",
        checkpointBefore: "refs/age/checkpoints/coord/u1/before",
      },
    ]);
    expect(
      decide(running, cmd("thread.merge", { threadId: "coord", strategy: "merge" }), testContext()),
    ).toMatchObject({ ok: false, code: "conflict" });
  });

  it("adds, removes, and sends review notes", () => {
    const added = decide(
      base(),
      cmd("review.addNote", {
        threadId: "coord",
        path: "a.ts",
        line: 1,
        side: "new",
        body: "fix",
      }),
      testContext(),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const noteId = added.events[0]?.type === "review.noteAdded" ? added.events[0].note.id : "";
    const withNote = applyEvents(
      base(),
      added.events.map((event, index) => ({ ...event, seq: index + 3, at })),
    );
    const removed = decide(
      withNote,
      cmd("review.removeNote", { threadId: "coord", noteId }),
      testContext(),
    );
    expect(removed.ok).toBe(true);
    const send = decide(
      applyEvents(base(), [
        {
          seq: 3,
          at,
          type: "review.noteAdded",
          commandId: "n",
          note: {
            id: "n1",
            threadId: "coord",
            path: "a.ts",
            line: 1,
            side: "new",
            body: "fix",
            createdAt: at,
          },
        },
      ]),
      cmd("review.send", { threadId: "coord" }),
      testContext(),
    );
    expect(send.ok).toBe(true);
    if (!send.ok) return;
    expect(send.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["turn.started", "review.notesSent"]),
    );
  });

  it("rejects review.send with no notes", () => {
    const decision = decide(base(), cmd("review.send", { threadId: "coord" }), testContext());
    expect(decision).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("fleet rows after spawn", () => {
  it("counts idle workers toward the live cap", () => {
    const decision = decide(
      base(),
      cmd("thread.spawn", {
        parentThreadId: "coord",
        provider: "demo",
        model: "demo",
        prompt: "work",
      }),
      testContext(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const model = applyEvents(
      base(),
      decision.events.map((event, index) => ({ ...event, seq: index + 3, at })),
    );
    const rows = fleetRows(model);
    expect(rows.find((row) => row.role === "worker")?.status).toBe("working");
  });
});
