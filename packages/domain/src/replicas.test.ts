import { describe, expect, it } from "vitest";
import type { AgeEvent, Thread } from "@wooky/contracts";
import { applyReplicaEvents, emptyReplicaModel } from "./replicas.ts";

const at = "2026-01-01T00:00:00.000Z";

const thread = (id: string): Thread => ({
  id,
  projectId: "p1",
  title: "Remote",
  provider: "demo",
  model: "demo",
  runtimeMode: "approve",
  worktree: null,
  providerSessionId: null,
  ownerDeviceId: "owner",
  movedTo: null,
  movedFrom: null,
  pullRequest: null,
  queue: [],
  status: "idle",
  createdAt: at,
  updatedAt: at,
});

function created(seq: number, id: string): AgeEvent {
  return {
    type: "thread.created",
    commandId: null,
    thread: thread(id),
    seq,
    at,
  };
}

describe("applyReplicaEvents", () => {
  it("folds an owner's events without mixing devices, and ignores a replayed seq", () => {
    const once = applyReplicaEvents(emptyReplicaModel(), "owner", [created(1, "remote")]);
    expect(once.replicas.owner?.threads.remote?.title).toBe("Remote");
    expect(once.replicas.owner?.seq).toBe(1);

    const renamed = applyReplicaEvents(once, "owner", [
      created(1, "remote"),
      {
        type: "thread.renamed",
        commandId: null,
        threadId: "remote",
        title: "Continued",
        seq: 2,
        at,
      },
    ]);
    expect(Object.keys(renamed.replicas.owner?.threads ?? {})).toEqual(["remote"]);
    expect(renamed.replicas.owner?.threads.remote?.title).toBe("Continued");

    const other = applyReplicaEvents(renamed, "laptop", [created(1, "elsewhere")]);
    expect(other.replicas.owner?.threads.remote?.title).toBe("Continued");
    expect(other.replicas.laptop?.threads.elsewhere?.id).toBe("elsewhere");
    expect(other.replicas.owner?.threads.elsewhere).toBeUndefined();
  });
});
