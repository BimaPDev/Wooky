import { describe, expect, it } from "vitest";
import type { AgeEvent, PendingEvent, Thread } from "@age/contracts";
import { applyEvents, emptyReadModel } from "./project.ts";
import { pendingApprovals } from "./selectors.ts";
import { plan, question, testLog } from "./test-log.ts";

let seq = 0;
const at = "2026-01-01T00:00:00.000Z";
function ev(event: PendingEvent): AgeEvent {
  seq += 1;
  return { ...event, seq, at } as AgeEvent;
}

function seed(): AgeEvent[] {
  seq = 0;
  return [
    ev({
      type: "project.added",
      commandId: "c1",
      project: { id: "p1", name: "demo", root: "/tmp/demo", createdAt: at },
    }),
    ev({
      type: "thread.created",
      commandId: "c2",
      thread: {
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
      },
    }),
    ev({
      type: "turn.started",
      commandId: "c3",
      threadId: "t1",
      turnId: "u1",
      prompt: "hi",
      provider: "demo",
      model: "demo",
      checkpointBefore: null,
    }),
  ];
}

describe("applyEvent", () => {
  it("builds threads and turns", () => {
    const model = applyEvents(emptyReadModel(), seed());
    expect(model.seq).toBe(3);
    expect(model.threads.t1?.status).toBe("running");
    expect(model.turns.t1).toHaveLength(1);
  });

  it("ignores replayed events at or below seq", () => {
    const events = seed();
    const once = applyEvents(emptyReadModel(), events);
    const twice = applyEvents(once, events);
    expect(twice).toBe(once);
  });

  it("appends deltas to message items", () => {
    const events = seed();
    events.push(
      ev({
        type: "turn.itemUpserted",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        item: { kind: "message", id: "m1", role: "assistant", text: "Hel" },
      }),
      ev({
        type: "turn.itemDelta",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        itemId: "m1",
        text: "lo",
      }),
    );
    const model = applyEvents(emptyReadModel(), events);
    expect(model.turns.t1?.[0]?.items[0]).toMatchObject({ text: "Hello" });
  });

  it("tracks waiting approvals and closes them when the turn ends", () => {
    const events = seed();
    events.push(
      ev({
        type: "turn.itemUpserted",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        item: {
          kind: "approval",
          id: "a1",
          requestId: "r1",
          tool: "command",
          title: "rm -rf build",
          detail: "",
          decision: null,
        },
      }),
      ev({
        type: "approval.requested",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        itemId: "a1",
        requestId: "r1",
      }),
    );
    const waiting = applyEvents(emptyReadModel(), events);
    expect(waiting.threads.t1?.status).toBe("waiting");
    expect(pendingApprovals(waiting, "t1")).toHaveLength(1);

    const done = applyEvents(waiting, [
      ev({
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId: "u1",
        status: "interrupted",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
      }),
    ]);
    expect(done.threads.t1?.status).toBe("idle");
    expect(done.turns.t1?.[0]?.items[0]).toMatchObject({ decision: "deny" });
  });

  it("derives the thread status from the remaining last turn after a revert", () => {
    const events = seed();
    const finish = (turnId: string, status: "failed" | "completed") =>
      ev({
        type: "turn.finished",
        commandId: null,
        threadId: "t1",
        turnId,
        status,
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
      });
    events.push(
      finish("u1", "failed"),
      ev({
        type: "turn.started",
        commandId: "c4",
        threadId: "t1",
        turnId: "u2",
        prompt: "again",
        provider: "demo",
        model: "demo",
        checkpointBefore: null,
      }),
      finish("u2", "completed"),
    );
    const before = applyEvents(emptyReadModel(), events);
    expect(before.threads.t1?.status).toBe("idle");

    const later = "2026-01-02T00:00:00.000Z";
    const revert = (turnId: string): AgeEvent => ({
      type: "turn.reverted",
      commandId: null,
      threadId: "t1",
      turnId,
      seq: ++seq,
      at: later,
    });
    const reverted = applyEvents(before, [revert("u2")]);
    expect(reverted.turns.t1?.map((turn) => turn.id)).toEqual(["u1"]);
    expect(reverted.threads.t1).toMatchObject({ status: "error", updatedAt: later });

    const empty = applyEvents(reverted, [revert("u1")]);
    expect(empty.threads.t1?.status).toBe("idle");

    const running = applyEvents(emptyReadModel(), [
      ...seed(),
      ev({ type: "turn.reverted", commandId: null, threadId: "t1", turnId: "missing" }),
    ]);
    expect(running.threads.t1?.status).toBe("running");
  });

  it("drops a project's threads when the project is removed", () => {
    const events = seed();
    events.push(ev({ type: "project.removed", commandId: "c9", projectId: "p1" }));
    const model = applyEvents(emptyReadModel(), events);
    expect(model.threads).toEqual({});
    expect(model.turns).toEqual({});
  });
});

describe("applyEvent: questions", () => {
  const asked = () =>
    testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .push({
        type: "question.requested",
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        requestId: "r1",
        questions: question("i1", "r1").questions,
      });

  it("adds the question item from the event and waits on the user", () => {
    const model = asked().model();
    expect(model.threads.t1?.status).toBe("waiting");
    expect(model.turns.t1?.[0]?.items).toEqual([question("i1", "r1")]);
  });

  it("keeps an item the runner already upserted instead of adding a second one", () => {
    const log = testLog().project("p1", "/work").thread("t1", "p1").start("t1", "u1");
    const upserted = { ...question("i1", "r1"), questions: [] };
    log.item("t1", "u1", upserted).push({
      type: "question.requested",
      threadId: "t1",
      turnId: "u1",
      itemId: "i1",
      requestId: "r1",
      questions: question("i1", "r1").questions,
    });
    expect(log.model().turns.t1?.[0]?.items).toEqual([upserted]);
  });

  it("records answers and resumes the turn", () => {
    const model = asked()
      .push({
        type: "question.resolved",
        threadId: "t1",
        turnId: "u1",
        requestId: "r1",
        answers: { db: ["SQLite"] },
      })
      .model();
    expect(model.threads.t1?.status).toBe("running");
    expect(model.turns.t1?.[0]?.items[0]).toMatchObject({ answers: { db: ["SQLite"] } });
    expect(model.turns.t1?.[0]?.items[0]).not.toHaveProperty("dismissed");
  });

  it("marks a null answer as dismissed", () => {
    const model = asked()
      .push({
        type: "question.resolved",
        threadId: "t1",
        turnId: "u1",
        requestId: "r1",
        answers: null,
      })
      .model();
    expect(model.threads.t1?.status).toBe("running");
    expect(model.turns.t1?.[0]?.items[0]).toMatchObject({ answers: null, dismissed: true });
  });

  it("keeps waiting while an approval or another question is still open", () => {
    const log = asked()
      .item("t1", "u1", {
        kind: "approval",
        id: "a1",
        requestId: "ra",
        tool: "command",
        title: "ls",
        detail: "",
        decision: null,
      })
      .push(
        { type: "approval.requested", threadId: "t1", turnId: "u1", itemId: "a1", requestId: "ra" },
        { type: "question.resolved", threadId: "t1", turnId: "u1", requestId: "r1", answers: {} },
      );
    expect(log.model().threads.t1?.status).toBe("waiting");
    log.push({
      type: "approval.resolved",
      threadId: "t1",
      turnId: "u1",
      requestId: "ra",
      decision: "allow",
    });
    expect(log.model().threads.t1?.status).toBe("running");

    const twoQuestions = asked().push(
      {
        type: "question.requested",
        threadId: "t1",
        turnId: "u1",
        itemId: "i2",
        requestId: "r2",
        questions: question("i2", "r2").questions,
      },
      { type: "question.resolved", threadId: "t1", turnId: "u1", requestId: "r1", answers: {} },
    );
    expect(twoQuestions.model().threads.t1?.status).toBe("waiting");
  });

  it("dismisses questions left open when the turn ends, interrupted or not", () => {
    for (const status of ["interrupted", "completed"] as const) {
      const model = asked().finish("t1", "u1", { status }).model();
      expect(model.threads.t1?.status).toBe("idle");
      expect(model.turns.t1?.[0]?.items[0]).toMatchObject({ answers: null, dismissed: true });
    }
  });

  it("leaves answered questions alone when the turn ends", () => {
    const model = asked()
      .push({
        type: "question.resolved",
        threadId: "t1",
        turnId: "u1",
        requestId: "r1",
        answers: { db: ["Postgres"] },
      })
      .finish("t1", "u1")
      .model();
    expect(model.turns.t1?.[0]?.items[0]).not.toHaveProperty("dismissed");
  });
});

describe("applyEvent: revert rewind", () => {
  const twoTurns = () =>
    testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .push({ type: "thread.sessionBound", threadId: "t1", providerSessionId: "s-old" })
      .start("t1", "u1")
      .finish("t1", "u1", { nativeRef: "msg-1" })
      .start("t1", "u2")
      .finish("t1", "u2", { nativeRef: "msg-2" });

  it("records the turn's nativeRef, and leaves it unset when the event has none", () => {
    const model = twoTurns().start("t1", "u3").finish("t1", "u3").model();
    expect(model.turns.t1?.map((turn) => turn.nativeRef)).toEqual(["msg-1", "msg-2", undefined]);
    expect(model.turns.t1?.[2]).not.toHaveProperty("nativeRef");
  });

  it("applies the rewound session id when the revert carries one", () => {
    const rewound = twoTurns()
      .push({
        type: "turn.reverted",
        threadId: "t1",
        turnId: "u2",
        providerSessionId: "s-fork",
        restoredFiles: false,
      })
      .model();
    expect(rewound.threads.t1?.providerSessionId).toBe("s-fork");
    expect(rewound.turns.t1?.map((turn) => turn.id)).toEqual(["u1"]);

    const reset = twoTurns()
      .push({ type: "turn.reverted", threadId: "t1", turnId: "u2", providerSessionId: null })
      .model();
    expect(reset.threads.t1?.providerSessionId).toBeNull();
  });

  it("keeps the session when the revert does not mention it", () => {
    const model = twoTurns().push({ type: "turn.reverted", threadId: "t1", turnId: "u2" }).model();
    expect(model.threads.t1?.providerSessionId).toBe("s-old");
  });
});

describe("applyEvent: queue", () => {
  const prompt = (id: string) => ({ id, prompt: `do ${id}`, queuedAt: "2026-01-01T00:00:00.000Z" });
  const queued = () =>
    testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .push(
        { type: "queue.added", threadId: "t1", item: prompt("q1") },
        { type: "queue.added", threadId: "t1", item: prompt("q2") },
        { type: "queue.added", threadId: "t1", item: prompt("q3") },
      );
  const ids = (log: ReturnType<typeof testLog>) =>
    log.model().threads.t1?.queue.map((item) => item.id);

  it("appends in order and ignores a repeated id", () => {
    const log = queued();
    expect(ids(log)).toEqual(["q1", "q2", "q3"]);
    log.push({ type: "queue.added", threadId: "t1", item: { ...prompt("q1"), prompt: "again" } });
    expect(ids(log)).toEqual(["q1", "q2", "q3"]);
    expect(log.model().threads.t1?.queue[0]?.prompt).toBe("do q1");
  });

  it("removes an item whether it started or was removed", () => {
    const log = queued().push(
      { type: "queue.removed", threadId: "t1", queueId: "q2", reason: "removed" },
      { type: "queue.removed", threadId: "t1", queueId: "q1", reason: "started" },
    );
    expect(ids(log)).toEqual(["q3"]);
  });

  it("starts a queued prompt from anywhere in the queue", () => {
    const log = queued()
      .push({ type: "queue.removed", threadId: "t1", queueId: "q3", reason: "started" })
      .start("t1", "u1", { prompt: "do q3", fromQueueId: "q3" });
    expect(ids(log)).toEqual(["q1", "q2"]);
    expect(log.model().turns.t1?.at(-1)).toMatchObject({ prompt: "do q3", status: "running" });
  });

  it("treats a thread without a queue (an undecoded old snapshot) as an empty queue", () => {
    const legacy = testLog().project("p1", "/work").thread("t1", "p1").model();
    const { queue: _queue, ...thread } = legacy.threads.t1 as Thread;
    const model = { ...legacy, threads: { t1: thread as Thread } };
    const next = applyEvents(model, [
      {
        type: "queue.added",
        seq: legacy.seq + 1,
        at: "2026-01-02T00:00:00.000Z",
        commandId: null,
        threadId: "t1",
        item: prompt("q1"),
      },
    ]);
    expect(next.threads.t1?.queue.map((item) => item.id)).toEqual(["q1"]);
  });

  it("does nothing for unknown items or threads", () => {
    const log = queued();
    const before = log.model();
    const noops = log
      .push(
        { type: "queue.removed", threadId: "t1", queueId: "nope", reason: "removed" },
        { type: "queue.removed", threadId: "missing", queueId: "q1", reason: "started" },
        { type: "queue.added", threadId: "missing", item: prompt("q9") },
      )
      .events.slice(before.seq);
    const after = applyEvents(before, noops);
    expect(after.seq).toBe(before.seq + 3);
    expect(after.threads).toBe(before.threads);
  });
});

describe("applyEvent: plan mode", () => {
  it("copies the interaction mode from configure and stamps it on turns", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .push({
        type: "thread.configured",
        threadId: "t1",
        provider: "demo",
        model: "demo",
        runtimeMode: "approve",
        handoff: false,
        interactionMode: "plan",
      })
      .start("t1", "u1", { interactionMode: "plan" });
    expect(log.model().threads.t1?.interactionMode).toBe("plan");
    expect(log.model().turns.t1?.[0]?.interactionMode).toBe("plan");

    log.finish("t1", "u1").push({
      type: "thread.configured",
      threadId: "t1",
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      handoff: false,
    });
    expect(log.model().threads.t1).toMatchObject({ interactionMode: "plan", runtimeMode: "full" });
  });

  it("supersedes the previous proposed plan when a new one arrives", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .item("t1", "u1", plan("old-accepted", "# A", "accepted"))
      .item("t1", "u1", plan("p1", "# One"))
      .finish("t1", "u1")
      .start("t1", "u2")
      .item("t1", "u2", plan("p2", "# Two"));
    const statuses = () =>
      log
        .model()
        .turns.t1?.flatMap((turn) => turn.items)
        .map((item) => (item.kind === "plan" ? `${item.id}:${item.status}` : item.id));
    expect(statuses()).toEqual(["old-accepted:accepted", "p1:superseded", "p2:proposed"]);

    log.item("t1", "u2", plan("p2", "# Two, edited"));
    expect(statuses()).toEqual(["old-accepted:accepted", "p1:superseded", "p2:proposed"]);
  });

  it("does not touch turns that hold no proposed plan", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .finish("t1", "u1")
      .start("t1", "u2");
    const before = log.model();
    const after = applyEvents(before, log.item("t1", "u2", plan("p1", "# One")).events);
    expect(after.turns.t1?.[0]).toBe(before.turns.t1?.[0]);
  });
});
