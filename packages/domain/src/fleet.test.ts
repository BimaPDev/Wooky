import { describe, expect, it } from "vitest";
import { AgeEvent, FleetRow, type Thread } from "@wooky/contracts";
import { applyEvents, emptyReadModel } from "./project.ts";
import {
  childrenOf,
  fleetRows,
  formatReviewPrompt,
  formatWorkerReport,
  groupThreads,
  reviewNotesFor,
} from "./selectors.ts";
import { question, testLog } from "./test-log.ts";

const at = "2026-01-01T00:00:00.000Z";

function bareThread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p1",
    title: id,
    provider: "demo",
    model: "demo",
    runtimeMode: "approve",
    worktree: null,
    providerSessionId: null,
    queue: [],
    status: "idle",
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

const approval = {
  kind: "approval" as const,
  id: "a1",
  requestId: "r1",
  tool: "command" as const,
  title: "pnpm test",
  detail: "pnpm test",
  decision: null,
};

describe("fleet events", () => {
  it("promotes the parent, stores the worker, and joins an existing group", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("parent", "p1")
      .push({
        type: "group.created",
        group: {
          id: "g1",
          projectId: "p1",
          kind: "orchestrated",
          prompt: "split the work",
          coordinatorThreadId: "parent",
          threadIds: [],
          createdAt: at,
        },
      })
      .push({
        type: "thread.spawned",
        parentThreadId: "parent",
        thread: bareThread("w1", { groupId: "g1", isolate: true }),
      });

    const model = log.model();
    expect(model.threads.parent?.role).toBe("coordinator");
    expect(model.threads.w1).toMatchObject({
      role: "worker",
      parentThreadId: "parent",
      groupId: "g1",
    });
    expect(model.turns.w1).toEqual([]);
    expect(model.groups.g1?.threadIds).toEqual(["w1"]);
    expect(childrenOf(model, "parent").map((thread) => thread.id)).toEqual(["w1"]);

    const parentUpdated = model.threads.parent?.updatedAt;
    log.push({
      type: "thread.spawned",
      parentThreadId: "parent",
      thread: bareThread("w2", {
        groupId: "g1",
        isolate: true,
        createdAt: "2026-01-01T00:05:00.000Z",
      }),
    });
    expect(log.model().threads.parent?.role).toBe("coordinator");
    expect(log.model().threads.parent?.updatedAt).toBe(parentUpdated);
    expect(log.model().groups.g1?.threadIds).toEqual(["w1", "w2"]);
    expect(childrenOf(log.model(), "parent").map((thread) => thread.id)).toEqual(["w1", "w2"]);
  });

  it("still records a worker when the parent or group is missing", () => {
    const log = testLog().push({
      type: "thread.spawned",
      parentThreadId: "gone",
      thread: bareThread("w1", { projectId: "p1" }),
    });
    expect(log.model().threads.w1).toMatchObject({ role: "worker", parentThreadId: "gone" });
    expect(log.model().groups).toEqual({});
  });

  it("records a winner, a merge, and a worker report", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("a", "p1", { groupId: "g1", role: "worker" })
      .thread("b", "p1", { groupId: "g1", role: "worker" })
      .push({
        type: "group.created",
        group: {
          id: "g1",
          projectId: "p1",
          kind: "fanout",
          prompt: "try both",
          threadIds: ["a", "b"],
          createdAt: at,
        },
      });
    log.push({ type: "group.winnerPicked", groupId: "missing", threadId: "a" });
    expect(log.model().groups.g1?.winnerThreadId).toBeUndefined();

    log.push({ type: "group.winnerPicked", groupId: "g1", threadId: "b" });
    expect(log.model().groups.g1?.winnerThreadId).toBe("b");
    expect(groupThreads(log.model(), "g1").map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(groupThreads(log.model(), "missing")).toEqual([]);

    log.push(
      {
        type: "thread.mergeChanged",
        threadId: "b",
        merge: { status: "merging", targetBranch: "main", at },
      },
      {
        type: "thread.mergeChanged",
        threadId: "b",
        merge: { status: "merged", targetBranch: "main", commit: "abc", at },
      },
      {
        type: "worker.reported",
        coordinatorThreadId: "none",
        workerThreadId: "b",
        turnId: "u1",
        summary: "shipped it",
        diffStat: { files: 2, additions: 10, deletions: 1 },
      },
    );
    expect(log.model().threads.b?.merge).toEqual({
      status: "merged",
      targetBranch: "main",
      commit: "abc",
      at,
    });
    expect(log.model().threads.b?.report).toMatchObject({
      turnId: "u1",
      summary: "shipped it",
      diffStat: { files: 2, additions: 10, deletions: 1 },
    });

    log.push({
      type: "worker.reported",
      coordinatorThreadId: "none",
      workerThreadId: "missing",
      turnId: "u9",
      summary: "nope",
    });
    expect(log.model().threads.b?.report?.summary).toBe("shipped it");
    expect(log.model().threads.missing).toBeUndefined();
  });

  it("adds, replaces, removes, and clears review notes", () => {
    const note = (id: string, path: string, line: number, body: string) => ({
      id,
      threadId: "t1",
      path,
      line,
      side: "new" as const,
      body,
      createdAt: at,
    });
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .push(
        { type: "review.noteAdded", note: note("n2", "src/b.ts", 3, "second") },
        { type: "review.noteAdded", note: note("n1", "src/a.ts", 10, "first") },
        { type: "review.noteAdded", note: note("n3", "src/a.ts", 2, "earlier") },
        { type: "review.noteAdded", note: { ...note("n1", "src/a.ts", 10, "first"), side: "old" } },
      );
    expect(reviewNotesFor(log.model(), "t1").map((item) => item.id)).toEqual(["n3", "n1", "n2"]);
    expect(reviewNotesFor(log.model(), "t1").find((item) => item.id === "n1")?.side).toBe("old");

    log.push({ type: "review.noteRemoved", threadId: "t1", noteId: "n2" });
    expect(reviewNotesFor(log.model(), "t1").map((item) => item.id)).toEqual(["n3", "n1"]);

    log.push({ type: "review.noteRemoved", threadId: "t1", noteId: "missing" });
    expect(reviewNotesFor(log.model(), "t1").map((item) => item.id)).toEqual(["n3", "n1"]);

    log.push({ type: "review.notesSent", threadId: "t1", noteIds: ["n1", "absent"] });
    expect(reviewNotesFor(log.model(), "t1").map((item) => item.id)).toEqual(["n3"]);
    log.push({ type: "review.notesSent", threadId: "t1", noteIds: ["n3"] });
    expect(log.model().reviewNotes).toEqual({});
    expect(reviewNotesFor(log.model(), "t1")).toEqual([]);
  });

  it("drops notes and group membership when a thread or project goes away", () => {
    const log = testLog()
      .project("p1", "/work")
      .project("p2", "/other")
      .thread("coord", "p1", { role: "coordinator" })
      .thread("w1", "p1", { role: "worker", parentThreadId: "coord", groupId: "g1" })
      .thread("keep", "p2")
      .push(
        {
          type: "group.created",
          group: {
            id: "g1",
            projectId: "p1",
            kind: "orchestrated",
            prompt: "delegate",
            coordinatorThreadId: "coord",
            threadIds: ["coord", "w1"],
            winnerThreadId: "w1",
            createdAt: at,
          },
        },
        {
          type: "group.created",
          group: {
            id: "g2",
            projectId: "p2",
            kind: "fanout",
            prompt: "elsewhere",
            threadIds: ["keep"],
            createdAt: at,
          },
        },
        {
          type: "review.noteAdded",
          note: {
            id: "n1",
            threadId: "w1",
            path: "src/a.ts",
            line: 1,
            side: "new",
            body: "rename",
            createdAt: at,
          },
        },
      );

    log.push({ type: "thread.removed", threadId: "w1" });
    expect(log.model().reviewNotes.w1).toBeUndefined();
    expect(log.model().groups.g1).toMatchObject({
      threadIds: ["coord"],
      coordinatorThreadId: "coord",
    });
    expect(log.model().groups.g1?.winnerThreadId).toBeUndefined();

    log.push({ type: "project.removed", projectId: "p1" });
    expect(log.model().threads.keep?.id).toBe("keep");
    expect(log.model().groups.g1).toBeUndefined();
    expect(log.model().groups.g2?.threadIds).toEqual(["keep"]);
    expect(log.model().reviewNotes).toEqual({});
  });

  it("replays a log of the new events, and a second pass changes nothing", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("parent", "p1")
      .push(
        {
          type: "group.created",
          group: {
            id: "g1",
            projectId: "p1",
            kind: "orchestrated",
            prompt: "split the work",
            coordinatorThreadId: "parent",
            threadIds: ["w1"],
            createdAt: at,
          },
        },
        {
          type: "thread.spawned",
          parentThreadId: "parent",
          thread: bareThread("w1", { groupId: "g1", isolate: true, role: "worker" }),
        },
        {
          type: "review.noteAdded",
          note: {
            id: "n1",
            threadId: "w1",
            path: "src/a.ts",
            line: 4,
            side: "new",
            body: "rename this",
            createdAt: at,
          },
        },
        { type: "review.notesSent", threadId: "w1", noteIds: ["n1"] },
        { type: "review.noteRemoved", threadId: "w1", noteId: "n1" },
        { type: "group.winnerPicked", groupId: "g1", threadId: "w1" },
        {
          type: "thread.mergeChanged",
          threadId: "w1",
          merge: { status: "conflict", targetBranch: "main", message: "src/a.ts", at },
        },
        {
          type: "worker.reported",
          coordinatorThreadId: "parent",
          workerThreadId: "w1",
          turnId: "u1",
          summary: "left a conflict in src/a.ts",
          diffStat: { files: 1, additions: 3, deletions: 0 },
        },
      );

    const events = log.events.map((event) => AgeEvent.parse(event));
    const once = applyEvents(emptyReadModel(), events);
    const twice = applyEvents(once, events);
    expect(twice).toBe(once);
    expect(once.threads.parent?.role).toBe("coordinator");
    expect(once.groups.g1?.winnerThreadId).toBe("w1");
    expect(once.threads.w1?.merge?.status).toBe("conflict");
    expect(once.threads.w1?.report?.summary).toBe("left a conflict in src/a.ts");
    expect(once.reviewNotes).toEqual({});
    expect(FleetRow.parse(fleetRows(once).find((row) => row.threadId === "w1"))).toMatchObject({
      role: "worker",
      groupId: "g1",
      parentThreadId: "parent",
      diffStat: { files: 1, additions: 3, deletions: 0 },
    });
  });
});

describe("fleetRows", () => {
  it("derives status from the open request, the running turn, then the last result", () => {
    const idle = testLog().project("p1", "/work").thread("solo", "p1");
    expect(fleetRows(idle.model())).toMatchObject([
      { threadId: "solo", role: "solo", status: "idle" },
    ]);

    const running = testLog().project("p1", "/work").thread("solo", "p1").start("solo", "u1");
    expect(fleetRows(running.model())[0]?.status).toBe("working");

    const asking = testLog()
      .project("p1", "/work")
      .thread("solo", "p1")
      .start("solo", "u1")
      .item("solo", "u1", question("q1", "rq"));
    expect(fleetRows(asking.model())[0]).toMatchObject({
      status: "waiting",
      waitingOn: "question",
    });

    const both = testLog()
      .project("p1", "/work")
      .thread("solo", "p1")
      .start("solo", "u1")
      .item("solo", "u1", approval)
      .item("solo", "u1", question("q1", "rq"));
    expect(fleetRows(both.model())[0]).toMatchObject({ status: "waiting", waitingOn: "approval" });

    const failed = testLog()
      .project("p1", "/work")
      .thread("solo", "p1")
      .start("solo", "u1")
      .finish("solo", "u1", { status: "failed", error: "crashed" });
    expect(fleetRows(failed.model())[0]?.status).toBe("failed");

    const finishedSolo = testLog()
      .project("p1", "/work")
      .thread("solo", "p1")
      .start("solo", "u1")
      .finish("solo", "u1");
    expect(fleetRows(finishedSolo.model())[0]?.status).toBe("idle");

    const worker = testLog()
      .project("p1", "/work")
      .thread("w", "p1", { role: "worker", parentThreadId: "c" })
      .start("w", "u1")
      .finish("w", "u1");
    expect(fleetRows(worker.model())[0]?.status).toBe("done");

    const interrupted = testLog()
      .project("p1", "/work")
      .thread("w", "p1", { role: "worker" })
      .start("w", "u1")
      .finish("w", "u1", { status: "interrupted" });
    expect(fleetRows(interrupted.model())[0]?.status).toBe("done");

    const member = testLog()
      .project("p1", "/work")
      .thread("m", "p1", { groupId: "g1" })
      .start("m", "u1")
      .finish("m", "u1");
    expect(fleetRows(member.model())[0]).toMatchObject({
      role: "solo",
      status: "done",
      groupId: "g1",
    });

    const coordinator = testLog()
      .project("p1", "/work")
      .thread("c", "p1", { role: "coordinator", groupId: "g1" })
      .start("c", "u1")
      .finish("c", "u1");
    expect(fleetRows(coordinator.model())[0]?.status).toBe("idle");

    const unstarted = testLog().project("p1", "/work").thread("w", "p1", { role: "worker" });
    expect(fleetRows(unstarted.model())[0]?.status).toBe("idle");
  });

  it("orders rows by last activity and shares one empty array when there are no threads", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("old", "p1")
      .thread("new", "p1")
      .start("old", "u1")
      .finish("old", "u1");
    expect(fleetRows(log.model()).map((row) => row.threadId)).toEqual(["old", "new"]);

    const none = fleetRows(emptyReadModel());
    expect(none).toEqual([]);
    expect(fleetRows(emptyReadModel())).toBe(none);
    expect(childrenOf(emptyReadModel(), "x")).toBe(reviewNotesFor(emptyReadModel(), "x"));
  });
});

describe("review prompt", () => {
  const notes = [
    {
      id: "n1",
      threadId: "t1",
      path: "src/a.ts",
      line: 12,
      side: "new" as const,
      body: "rename this",
      createdAt: at,
    },
    {
      id: "n2",
      threadId: "t1",
      path: "src/a.ts",
      line: 4,
      side: "old" as const,
      body: "keep this",
      createdAt: at,
    },
  ];

  it("formats notes as markdown bullets and appends extra text", () => {
    expect(formatReviewPrompt(notes.slice(0, 1))).toBe(
      "Review notes:\n\n- `src/a.ts:12` (new): rename this",
    );
    expect(formatReviewPrompt(notes)).toBe(
      "Review notes:\n\n- `src/a.ts:12` (new): rename this\n- `src/a.ts:4` (old): keep this",
    );
    expect(formatReviewPrompt(notes.slice(0, 1), "  Focus on names.  ")).toBe(
      "Review notes:\n\n- `src/a.ts:12` (new): rename this\n\nFocus on names.",
    );
    expect(formatReviewPrompt([], "   ")).toBe("Review notes:");
    expect(formatReviewPrompt([])).toBe("Review notes:");
  });

  it("formats the coordinator follow-up for a worker report", () => {
    expect(
      formatWorkerReport({
        workerThreadId: "w1",
        title: "Add a health check",
        turnId: "u1",
        summary: "Added /health.",
        diffStat: { files: 2, additions: 10, deletions: 1 },
      }),
    ).toBe("Worker Add a health check (w1) finished turn u1.\n\nAdded /health.\n\n2 files, +10 -1");
    expect(formatWorkerReport({ workerThreadId: "w1", turnId: "u1", summary: "No diff." })).toBe(
      "Worker w1 finished turn u1.\n\nNo diff.",
    );
  });
});
