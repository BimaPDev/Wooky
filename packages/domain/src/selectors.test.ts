import { describe, expect, it } from "vitest";
import {
  handoffTranscript,
  latestPlan,
  nextQueued,
  pendingQuestions,
  queuedPrompts,
  resumePoint,
  threadsSharingWorkspace,
} from "./selectors.ts";
import { plan, question, testLog } from "./test-log.ts";

describe("pendingQuestions", () => {
  it("lists only open questions of the running turn", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .item("t1", "u1", question("i1", "r1"))
      .item("t1", "u1", { ...question("i2", "r2"), answers: { db: ["SQLite"] } })
      .item("t1", "u1", { ...question("i3", "r3"), dismissed: true })
      .item("t1", "u1", question("i4", "r4"));
    expect(pendingQuestions(log.model(), "t1").map((item) => item.id)).toEqual(["i1", "i4"]);

    log.finish("t1", "u1");
    expect(pendingQuestions(log.model(), "t1")).toEqual([]);
    expect(pendingQuestions(log.model(), "missing")).toEqual([]);
  });

  it("returns one shared empty array when nothing is open, so selections stay stable", () => {
    const log = testLog().project("p1", "/work").thread("t1", "p1");
    const idle = pendingQuestions(log.model(), "t1");
    expect(Object.isFrozen(idle)).toBe(true);
    expect(pendingQuestions(log.model(), "missing")).toBe(idle);
    log.start("t1", "u1").item("t1", "u1", { ...question("i1", "r1"), dismissed: true });
    expect(pendingQuestions(log.model(), "t1")).toBe(idle);
  });
});

describe("queuedPrompts and nextQueued", () => {
  it("returns the queue in order and its head", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const log = testLog().project("p1", "/work").thread("t1", "p1");
    expect(queuedPrompts(log.model(), "t1")).toEqual([]);
    expect(nextQueued(log.model(), "t1")).toBeNull();

    log.push(
      { type: "queue.added", threadId: "t1", item: { id: "q1", prompt: "one", queuedAt: at } },
      { type: "queue.added", threadId: "t1", item: { id: "q2", prompt: "two", queuedAt: at } },
    );
    expect(queuedPrompts(log.model(), "t1").map((item) => item.prompt)).toEqual(["one", "two"]);
    expect(nextQueued(log.model(), "t1")?.id).toBe("q1");

    log.push({ type: "queue.removed", threadId: "t1", queueId: "q2", reason: "started" });
    expect(queuedPrompts(log.model(), "t1").map((item) => item.id)).toEqual(["q1"]);
    expect(nextQueued(log.model(), "t1")?.id).toBe("q1");
    expect(queuedPrompts(log.model(), "missing")).toEqual([]);
    expect(nextQueued(log.model(), "missing")).toBeNull();
  });

  it("returns one shared empty array for an unknown thread or an empty queue", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const log = testLog().project("p1", "/work").thread("t1", "p1");
    const none = queuedPrompts(log.model(), "missing");
    expect(Object.isFrozen(none)).toBe(true);
    expect(queuedPrompts(log.model(), "t1")).toBe(none);
    log.push(
      { type: "queue.added", threadId: "t1", item: { id: "q1", prompt: "one", queuedAt: at } },
      { type: "queue.removed", threadId: "t1", queueId: "q1", reason: "removed" },
    );
    expect(queuedPrompts(log.model(), "t1")).toBe(none);
  });
});

describe("latestPlan", () => {
  it("returns the newest plan across turns, whatever its status", () => {
    const log = testLog().project("p1", "/work").thread("t1", "p1");
    expect(latestPlan(log.model(), "t1")).toBeNull();

    log
      .start("t1", "u1")
      .item("t1", "u1", plan("a", "# A"))
      .item("t1", "u1", plan("b", "# B"))
      .finish("t1", "u1")
      .start("t1", "u2")
      .item("t1", "u2", { kind: "message", id: "m1", role: "assistant", text: "no plan" });
    expect(latestPlan(log.model(), "t1")).toMatchObject({ id: "b", status: "proposed" });

    log.item("t1", "u2", plan("c", "# C", "accepted"));
    expect(latestPlan(log.model(), "t1")).toMatchObject({ id: "c", markdown: "# C" });
  });
});

describe("resumePoint", () => {
  const handoff = (provider: "claude" | "codex") => ({
    type: "thread.configured" as const,
    threadId: "t1",
    provider,
    model: provider,
    runtimeMode: "approve" as const,
    handoff: true,
  });

  it("is the nativeRef of the last finished turn still in the thread", () => {
    const log = testLog().project("p1", "/work").thread("t1", "p1");
    expect(resumePoint(log.model(), "t1")).toBeNull();

    log
      .start("t1", "u1")
      .finish("t1", "u1", { nativeRef: "msg-1" })
      .start("t1", "u2")
      .finish("t1", "u2", { nativeRef: "msg-2" });
    expect(resumePoint(log.model(), "t1")).toBe("msg-2");

    log.push({ type: "turn.reverted", threadId: "t1", turnId: "u2" });
    expect(resumePoint(log.model(), "t1")).toBe("msg-1");

    log.start("t1", "u3");
    expect(resumePoint(log.model(), "t1")).toBe("msg-1");

    log.finish("t1", "u3", { status: "failed" });
    expect(resumePoint(log.model(), "t1")).toBe("msg-1");
    expect(resumePoint(log.model(), "missing")).toBeNull();
  });

  it("walks back past running turns and turns without a nativeRef", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .finish("t1", "u1", { nativeRef: "msg-1" })
      .start("t1", "u2")
      .finish("t1", "u2", { nativeRef: null })
      .start("t1", "u3")
      .finish("t1", "u3", { status: "interrupted" })
      .start("t1", "u4");
    expect(resumePoint(log.model(), "t1")).toBe("msg-1");
  });

  it("is null when the thread was handed off and the new provider recorded no ref", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1", { provider: "claude" })
      .start("t1", "u1", { provider: "claude" })
      .finish("t1", "u1", { nativeRef: "claude-uuid" })
      .push(handoff("codex"));
    expect(resumePoint(log.model(), "t1")).toBeNull();

    log.start("t1", "u2", { provider: "codex" }).finish("t1", "u2");
    expect(resumePoint(log.model(), "t1")).toBeNull();
  });

  it("never returns another provider's ref after handing back", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1", { provider: "claude" })
      .start("t1", "u1", { provider: "claude" })
      .finish("t1", "u1", { nativeRef: "claude-1" })
      .push(handoff("codex"))
      .start("t1", "u2", { provider: "codex" })
      .finish("t1", "u2", { nativeRef: "codex-2" })
      .push(handoff("claude"))
      .start("t1", "u3", { provider: "claude" })
      .finish("t1", "u3", { nativeRef: "claude-3" });
    expect(resumePoint(log.model(), "t1")).toBe("claude-3");
    expect(resumePoint(log.model(), "t1", "u3")).toBeNull();

    log.push({ type: "turn.reverted", threadId: "t1", turnId: "u3" });
    expect(resumePoint(log.model(), "t1")).toBeNull();
  });

  it("considers only the turns before beforeTurnId", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .finish("t1", "u1", { nativeRef: "msg-1" })
      .start("t1", "u2")
      .finish("t1", "u2", { nativeRef: null })
      .start("t1", "u3")
      .finish("t1", "u3", { nativeRef: "msg-3" });
    expect(resumePoint(log.model(), "t1", "u3")).toBe("msg-1");
    expect(resumePoint(log.model(), "t1", "u2")).toBe("msg-1");
    expect(resumePoint(log.model(), "t1", "u1")).toBeNull();
    expect(resumePoint(log.model(), "t1", "unknown")).toBeNull();
  });

  it("is null when no finished turn has a nativeRef", () => {
    const log = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .finish("t1", "u1", { status: "failed" })
      .start("t1", "u2")
      .finish("t1", "u2", { nativeRef: null });
    expect(resumePoint(log.model(), "t1")).toBeNull();
  });
});

describe("threadsSharingWorkspace", () => {
  const worktree = { path: "/work/.wooky-worktrees/w", branch: "wooky/w" };
  const log = testLog()
    .project("p1", "/work")
    .project("p2", "/other")
    .thread("a", "p1")
    .thread("b", "p1")
    .thread("own", "p1", { worktree })
    .thread("pending", "p1", { isolate: true })
    .thread("elsewhere", "p2");

  it("lists other project-root threads of the same root", () => {
    const model = log.model();
    expect(threadsSharingWorkspace(model, "a").map((thread) => thread.id)).toEqual(["b"]);
    expect(threadsSharingWorkspace(model, "b").map((thread) => thread.id)).toEqual(["a"]);
    expect(threadsSharingWorkspace(model, "elsewhere")).toEqual([]);
  });

  it("is empty for a thread that has, or will get, its own worktree", () => {
    const model = log.model();
    expect(threadsSharingWorkspace(model, "own")).toEqual([]);
    expect(threadsSharingWorkspace(model, "pending")).toEqual([]);
    expect(threadsSharingWorkspace(model, "missing")).toEqual([]);
  });

  it("returns one shared empty array when nothing is shared", () => {
    const model = log.model();
    const none = threadsSharingWorkspace(model, "own");
    expect(Object.isFrozen(none)).toBe(true);
    for (const id of ["pending", "missing", "elsewhere"])
      expect(threadsSharingWorkspace(model, id)).toBe(none);
  });
});

describe("handoffTranscript", () => {
  it("carries the live plans and drops superseded ones", () => {
    const model = testLog()
      .project("p1", "/work")
      .thread("t1", "p1")
      .start("t1", "u1")
      .item("t1", "u1", plan("a", "1. Old idea"))
      .item("t1", "u1", plan("b", "1. Add a cache\n2. Test it"))
      .finish("t1", "u1")
      .model();
    const transcript = handoffTranscript(model, "t1");
    expect(transcript).toContain("Plan (proposed):\n1. Add a cache\n2. Test it");
    expect(transcript).not.toContain("Old idea");
  });
});
