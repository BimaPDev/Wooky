import { describe, expect, it } from "vitest";
import { Command, FanoutStartParams, ThreadSpawnParams } from "./commands.ts";
import { AgeEvent } from "./events.ts";
import { Thread } from "./model.ts";
import { ReadModel, RpcMethods } from "./rpc.ts";

const thread = {
  id: "t1",
  projectId: "p1",
  title: "New thread",
  provider: "demo",
  model: "demo",
  runtimeMode: "approve",
  worktree: null,
  providerSessionId: null,
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("fleet wire shapes", () => {
  it("decodes a pre-fleet thread and snapshot", () => {
    expect(Thread.parse(thread).role).toBeUndefined();
    expect(Thread.parse(thread).merge).toBeUndefined();
    const model = ReadModel.parse({
      seq: 1,
      projects: {},
      threads: { t1: thread },
      turns: { t1: [] },
    });
    expect(model.groups).toEqual({});
    expect(model.reviewNotes).toEqual({});
    expect(model.threads.t1?.queue).toEqual([]);
  });

  it("accepts a spawn, a full fan-out, and a worker report", () => {
    expect(
      Command.parse({
        commandId: "c1",
        type: "thread.spawn",
        parentThreadId: "parent",
        provider: "demo",
        model: "demo",
        prompt: "look at the tests",
      }),
    ).toMatchObject({ type: "thread.spawn" });

    const targets = Array.from({ length: 6 }, (_, index) => ({
      provider: "demo" as const,
      model: `m${index}`,
    }));
    expect(
      FanoutStartParams.parse({ projectId: "p1", prompt: "try", targets, runtimeMode: "full" })
        .targets,
    ).toHaveLength(6);
    expect(
      FanoutStartParams.safeParse({
        projectId: "p1",
        prompt: "try",
        targets: [],
        runtimeMode: "full",
      }).success,
    ).toBe(false);
    expect(
      FanoutStartParams.safeParse({
        projectId: "p1",
        prompt: "try",
        targets: [...targets, { provider: "demo", model: "extra" }],
        runtimeMode: "full",
      }).success,
    ).toBe(false);

    expect(
      AgeEvent.parse({
        type: "worker.reported",
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        commandId: null,
        coordinatorThreadId: "c",
        workerThreadId: "w",
        turnId: "u",
        summary: "x".repeat(8000),
      }).type,
    ).toBe("worker.reported");
    expect(
      AgeEvent.safeParse({
        type: "worker.reported",
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        commandId: null,
        coordinatorThreadId: "c",
        workerThreadId: "w",
        turnId: "u",
        summary: "x".repeat(8001),
      }).success,
    ).toBe(false);
  });

  it("rejects a review note outside its bounds and a wait past ten minutes", () => {
    const note = {
      commandId: "c1",
      type: "review.addNote" as const,
      threadId: "t1",
      path: "src/a.ts",
      line: 1,
      side: "new" as const,
      body: "x".repeat(4000),
    };
    expect(Command.safeParse(note).success).toBe(true);
    expect(Command.safeParse({ ...note, body: "x".repeat(4001) }).success).toBe(false);
    expect(Command.safeParse({ ...note, line: 0 }).success).toBe(false);
    expect(Command.safeParse({ ...note, body: "" }).success).toBe(false);

    expect(
      RpcMethods["agents.wait"].params.safeParse({ threadIds: ["w"], timeoutMs: 600_000 }).success,
    ).toBe(true);
    expect(
      RpcMethods["agents.wait"].params.safeParse({ threadIds: ["w"], timeoutMs: 600_001 }).success,
    ).toBe(false);
    expect(
      RpcMethods["agents.wait"].params.safeParse({ threadIds: ["w"], timeoutMs: 0 }).success,
    ).toBe(false);
    expect(
      RpcMethods["agents.wait"].params.safeParse({ threadIds: ["w"], timeoutMs: 999 }).success,
    ).toBe(false);
    expect(
      RpcMethods["agents.wait"].params.safeParse({ threadIds: ["w"], timeoutMs: 1000 }).success,
    ).toBe(true);
    expect(
      ThreadSpawnParams.safeParse({
        parentThreadId: "p",
        provider: "demo",
        model: "",
        prompt: "go",
      }).success,
    ).toBe(false);
  });
});
