import { describe, expect, it } from "vitest";
import { DeviceSettings, type ReadModel, type Thread } from "@wooky/contracts";
import { applyEvents, activeTurn, emptyReadModel } from "@wooky/domain";
import { testContext } from "../testing.ts";
import { decide } from "../orchestrator/decide.ts";

const at = "2026-01-01T00:00:00.000Z";

function modelWithThread(status: Thread["status"] = "idle"): ReadModel {
  const base = applyEvents(emptyReadModel(), [
    {
      type: "project.added",
      commandId: "c1",
      project: { id: "p1", name: "p", root: "/work/p", createdAt: at, settings: { scripts: [] } },
      seq: 1,
      at,
    },
    {
      type: "thread.created",
      commandId: "c2",
      thread: {
        id: "t1",
        projectId: "p1",
        title: "Thread",
        provider: "demo",
        model: "demo",
        runtimeMode: "approve",
        worktree: null,
        providerSessionId: null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        pullRequest: null,
        queue: [],
        status,
        createdAt: at,
        updatedAt: at,
      },
      seq: 2,
      at,
    },
  ]);
  if (status === "running") {
    return applyEvents(base, [
      {
        type: "turn.started",
        commandId: "c3",
        threadId: "t1",
        turnId: "u1",
        prompt: "Go",
        provider: "demo",
        model: "demo",
        checkpointBefore: null,
        seq: 3,
        at,
      },
    ]);
  }
  return base;
}

const syncOn = DeviceSettings.parse({
  sync: {
    enabled: true,
    categories: { files: true, threads: true, settings: true, themes: true, ignoredFiles: false },
    peers: ["peer-b"],
    projectMap: {},
  },
});

describe("anywhere decide", () => {
  it("accepts claim and emits claimRequested", () => {
    const ctx = { ...testContext(), deviceSettings: syncOn };
    const decision = decide(
      modelWithThread(),
      {
        commandId: "claim-1",
        type: "thread.claim",
        ownerDeviceId: "peer-a",
        ownerThreadId: "remote-t",
        projectId: "p1",
      },
      ctx,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.events[0]?.type).toBe("thread.claimRequested");
    expect(decision.effects[0]?.kind).toBe("claimThread");
  });

  it("rejects a duplicate claim", () => {
    const pending = applyEvents(modelWithThread(), [
      {
        type: "thread.claimRequested",
        commandId: "c4",
        claimId: "claim-old",
        ownerDeviceId: "peer-a",
        ownerThreadId: "remote-t",
        projectId: "p1",
        seq: 3,
        at,
      },
    ]);
    const decision = decide(
      pending,
      {
        commandId: "claim-2",
        type: "thread.claim",
        ownerDeviceId: "peer-a",
        ownerThreadId: "remote-t",
        projectId: "p1",
      },
      { ...testContext(), deviceSettings: syncOn },
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("conflict");
  });

  it("rejects release while running without force", () => {
    const decision = decide(
      modelWithThread("running"),
      {
        commandId: "rel",
        type: "thread.release",
        threadId: "t1",
        toDeviceId: "peer-b",
      },
      testContext(),
    );
    expect(decision.ok).toBe(false);
  });

  it("releases with force and interrupts", () => {
    const model = modelWithThread("running");
    const turn = activeTurn(model, "t1");
    const decision = decide(
      model,
      {
        commandId: "rel",
        type: "thread.release",
        threadId: "t1",
        toDeviceId: "peer-b",
        force: true,
      },
      testContext(),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.events[0]?.type).toBe("thread.released");
    expect(decision.effects[0]).toMatchObject({ kind: "turn.interrupt", turnId: turn?.id });
  });
});
