import { describe, expect, it } from "vitest";
import type { Thread } from "@age/contracts";
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

describe("agents.wait connection lifecycle", () => {
  it("resolves pending when the abort signal fires", async () => {
    const home = await tempDir("wait-abort");
    const store = openEventStore(home, () => at);
    store.commit({
      commandId: "seed",
      events: [
        {
          type: "thread.spawned",
          commandId: "seed",
          parentThreadId: "coord",
          thread: worker("w1"),
        },
      ],
      effects: [],
    });
    const abort = new AbortController();
    const pending = waitForAgentThreads(store, ["w1"], 60_000, abort.signal);
    abort.abort();
    const result = await pending;
    expect(result.pending).toEqual(["w1"]);
    store.close();
  });
});
