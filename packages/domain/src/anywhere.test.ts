import { describe, expect, it } from "vitest";
import type { AgeEvent, HistoryTurn, Thread } from "@wooky/contracts";
import { applyEvents, emptyReadModel } from "./project.ts";
import { testLog } from "./test-log.ts";

const at = "2026-01-01T00:01:00.000Z";

function thread(extra: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Moved",
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
    status: "idle",
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

describe("anywhere reducer", () => {
  it("replaces project settings and leaves other projects alone", () => {
    const log = testLog().project("p1", "/work/a").project("p2", "/work/b");
    const next = applyEvents(log.model(), [
      {
        type: "project.configured",
        commandId: "c",
        projectId: "p1",
        settings: {
          scripts: [{ id: "dev", name: "Dev", command: "pnpm dev", runOnWorktreeCreate: false }],
          defaultPreviewUrl: "http://localhost:${PORT}",
        },
        seq: 3,
        at,
      },
    ]);
    expect(next.projects.p1?.settings.scripts.map((script) => script.id)).toEqual(["dev"]);
    expect(next.projects.p1?.settings.defaultPreviewUrl).toBe("http://localhost:${PORT}");
    expect(next.projects.p2?.settings).toEqual({ scripts: [] });
  });

  it("ignores configure for a missing project", () => {
    const before = emptyReadModel();
    const after = applyEvents(before, [
      {
        type: "project.configured",
        commandId: "c",
        projectId: "missing",
        settings: { scripts: [] },
        seq: 1,
        at,
      },
    ]);
    expect(after.projects).toEqual({});
    expect(after.seq).toBe(1);
  });

  it("sets movedTo when a thread is released", () => {
    const model = testLog().project("p1", "/work").thread("t1", "p1").model();
    const released = applyEvents(model, [
      {
        type: "thread.released",
        commandId: "c",
        threadId: "t1",
        toDeviceId: "other-device",
        seq: model.seq + 1,
        at,
      },
    ]);
    expect(released.threads.t1?.movedTo).toEqual({ deviceId: "other-device", at });
    expect(released.threads.t1?.ownerDeviceId).toBeNull();
  });

  it("imports a thread with movedFrom and an empty turn list", () => {
    const model = testLog().project("p1", "/work").model();
    const imported = applyEvents(model, [
      {
        type: "thread.imported",
        commandId: "c",
        thread: thread({ id: "local", title: "From home" }),
        sourceDeviceId: "other-device",
        sourceThreadId: "remote-thread",
        transcript: "the conversation so far",
        historyTurns: [],
        seq: model.seq + 1,
        at,
      },
    ]);
    expect(imported.threads.local?.movedFrom).toEqual({
      deviceId: "other-device",
      threadId: "remote-thread",
    });
    expect(imported.threads.local?.title).toBe("From home");
    expect(imported.turns.local).toEqual([]);
  });

  it("links a pull request and clears it", () => {
    const model = testLog().project("p1", "/work").thread("t1", "p1").model();
    const pr = {
      url: "https://github.com/acme/app/pull/4",
      number: 4,
      state: "open" as const,
      branch: "wooky/t1",
    };
    const linked = applyEvents(model, [
      {
        type: "thread.prLinked",
        commandId: null,
        threadId: "t1",
        pullRequest: pr,
        seq: model.seq + 1,
        at,
      },
    ]);
    expect(linked.threads.t1?.pullRequest).toEqual(pr);
    const cleared = applyEvents(linked, [
      {
        type: "thread.prLinked",
        commandId: null,
        threadId: "t1",
        pullRequest: null,
        seq: linked.seq + 1,
        at,
      },
    ]);
    expect(cleared.threads.t1?.pullRequest).toBeNull();
  });

  it("fills ownership defaults when an old thread event omitted them", () => {
    const event = {
      type: "thread.created",
      commandId: "c",
      thread: {
        id: "t1",
        projectId: "p1",
        title: "Old",
        provider: "demo",
        model: "demo",
        runtimeMode: "approve",
        worktree: null,
        providerSessionId: null,
        status: "idle",
        createdAt: at,
        updatedAt: at,
      },
      seq: 1,
      at,
    } as AgeEvent;
    const model = applyEvents(emptyReadModel(), [event]);
    expect(model.threads.t1).toMatchObject({
      ownerDeviceId: null,
      movedTo: null,
      movedFrom: null,
      pullRequest: null,
    });
  });

  it("keeps imported history and appends a later turn after it", () => {
    const model = testLog().project("p1", "/work").model();
    const imported = applyEvents(model, [
      {
        type: "thread.imported",
        commandId: "c",
        thread: thread({ id: "local", title: "From home" }),
        sourceDeviceId: "other-device",
        sourceThreadId: "remote-thread",
        transcript: "handoff",
        historyTurns: [historyTurn("h1", "remote-thread"), historyTurn("h2", "remote-thread")],
        seq: model.seq + 1,
        at,
      },
    ]);
    expect(imported.turns.local?.map((turn) => [turn.id, turn.threadId])).toEqual([
      ["h1", "local"],
      ["h2", "local"],
    ]);
    const continued = applyEvents(imported, [
      {
        type: "turn.started",
        commandId: "c2",
        threadId: "local",
        turnId: "u-new",
        prompt: "continue",
        provider: "demo",
        model: "demo",
        checkpointBefore: null,
        seq: imported.seq + 1,
        at,
      },
    ]);
    expect(continued.turns.local?.map((turn) => turn.id)).toEqual(["h1", "h2", "u-new"]);
    expect(continued.turns.local?.at(-1)?.threadId).toBe("local");
  });

  it("tracks a claim, ignores a duplicate, and clears it on failure or import", () => {
    const model = testLog().project("p1", "/work").model();
    const requested = applyEvents(model, [claim("claim-1", model.seq + 1)]);
    expect(requested.pendingClaims["claim-1"]).toEqual({
      claimId: "claim-1",
      ownerDeviceId: "other-device",
      ownerThreadId: "remote-thread",
      projectId: "p1",
      at,
    });

    const duplicate = applyEvents(requested, [claim("claim-2", requested.seq + 1)]);
    expect(Object.keys(duplicate.pendingClaims)).toEqual(["claim-1"]);

    const failed = applyEvents(requested, [
      {
        type: "thread.claimFailed",
        commandId: null,
        claimId: "claim-1",
        reason: "The owner is offline.",
        seq: requested.seq + 1,
        at,
      },
    ]);
    expect(failed.pendingClaims).toEqual({});

    const imported = applyEvents(requested, [
      {
        type: "thread.imported",
        commandId: "claim-1",
        claimId: "claim-1",
        thread: thread({ id: "local" }),
        sourceDeviceId: "other-device",
        sourceThreadId: "remote-thread",
        transcript: "handoff",
        historyTurns: [],
        seq: requested.seq + 1,
        at,
      },
    ]);
    expect(imported.pendingClaims).toEqual({});
    expect(imported.threads.local?.movedFrom?.threadId).toBe("remote-thread");
  });
});

function historyTurn(id: string, threadId: string): HistoryTurn {
  return {
    id,
    threadId,
    prompt: id,
    provider: "demo",
    model: "demo",
    status: "completed",
    items: [],
    startedAt: at,
    endedAt: at,
    checkpointBefore: null,
    checkpointAfter: null,
    changedFiles: [],
    usage: null,
    error: null,
  };
}

function claim(claimId: string, seq: number): AgeEvent {
  return {
    type: "thread.claimRequested",
    commandId: claimId,
    claimId,
    ownerDeviceId: "other-device",
    ownerThreadId: "remote-thread",
    projectId: "p1",
    seq,
    at,
  };
}
