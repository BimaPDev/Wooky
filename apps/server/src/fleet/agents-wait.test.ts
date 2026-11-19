import { describe, expect, it } from "vitest";
import type { Thread } from "@wooky/contracts";
import { openEventStore } from "../store/event-store.ts";
import { tempDir } from "../testing.ts";
import { waitForAgentThreads } from "./agents-wait.ts";

const at = "2026-01-01T00:00:00.000Z";

function worker(id: string): Thread {
  return {
    id,
    projectId: "p1",
    title: id,
    provider: "demo",
    model: "demo",
    runtimeMode: "approve",
    worktree: null,
    role: "worker",
    parentThreadId: "coord",
    providerSessionId: null,
    queue: [],
    status: "idle",
    createdAt: at,
    updatedAt: at,
  };
}

describe("agents.wait", () => {
  it("resolves when worker turns finish via events", async () => {
    const home = await tempDir("wait");
    const store = openEventStore(home, () => at);
    store.commit({
      commandId: "seed",
      events: [
        {
          type: "project.added",
          commandId: "seed",
          project: { id: "p1", name: "demo", root: "/work", createdAt: at },
        },
        {
          type: "thread.created",
          commandId: "seed",
          thread: {
            id: "coord",
            projectId: "p1",
            title: "coord",
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
        },
        {
          type: "thread.spawned",
          commandId: "seed",
          parentThreadId: "coord",
          thread: worker("w1"),
        },
      ],
      effects: [],
    });

    const pending = waitForAgentThreads(store, ["w1"], 30_000);
    store.appendInternal([
      {
        type: "turn.started",
        commandId: "s",
        threadId: "w1",
        turnId: "u1",
        prompt: "go",
        provider: "demo",
        model: "demo",
        checkpointBefore: "refs/wooky/checkpoints/w1/u1/before",
      },
      {
        type: "turn.finished",
        commandId: null,
        threadId: "w1",
        turnId: "u1",
        status: "completed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
      },
    ]);
    const result = await pending;
    expect(result.pending).toEqual([]);
    expect(result.finished).toEqual(["w1"]);
    store.close();
  });
});
