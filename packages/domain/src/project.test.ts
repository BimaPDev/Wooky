import { describe, expect, it } from "vitest";
import type { AgeEvent, PendingEvent } from "@age/contracts";
import { applyEvents, emptyReadModel } from "./project.ts";
import { pendingApprovals } from "./selectors.ts";

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

  it("drops a project's threads when the project is removed", () => {
    const events = seed();
    events.push(ev({ type: "project.removed", commandId: "c9", projectId: "p1" }));
    const model = applyEvents(emptyReadModel(), events);
    expect(model.threads).toEqual({});
    expect(model.turns).toEqual({});
  });
});
