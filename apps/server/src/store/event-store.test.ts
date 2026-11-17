import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { PendingEvent } from "@age/contracts";
import type { Effect } from "../orchestrator/effects.ts";
import { tempDir } from "../testing.ts";
import { openEventStore } from "./event-store.ts";

const clock = () => "2026-01-01T00:00:00.000Z";

const projectAdded = (id: string, commandId: string | null = "c1"): PendingEvent => ({
  type: "project.added",
  commandId,
  project: { id, name: id, root: `/work/${id}`, createdAt: clock() },
});

function effectStatuses(home: string): string[] {
  const db = new DatabaseSync(join(home, "state.sqlite"));
  const rows = db.prepare("SELECT status FROM effects ORDER BY id").all() as { status: string }[];
  db.close();
  return rows.map((row) => row.status);
}

describe("event store", () => {
  it("commits events, receipt and effects together and notifies after commit", async () => {
    const home = await tempDir("store");
    const store = openEventStore(home, clock);
    const seen: number[] = [];
    store.subscribe((events) => {
      seen.push(...events.map((event) => event.seq));
      expect(store.model.seq).toBe(events.at(-1)?.seq);
    });
    const effect: Effect = { kind: "worktree.create", threadId: "t1", projectRoot: "/work/a" };
    const committed = store.commit({
      commandId: "c1",
      events: [projectAdded("a"), projectAdded("b")],
      effects: [effect],
    });

    expect(committed.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(committed.effects).toEqual([{ ...effect, id: 1 }]);
    expect(committed.result).toEqual({ accepted: true, duplicate: false, seq: 2 });
    expect(store.receipt("c1")).toEqual(committed.result);
    expect(seen).toEqual([1, 2]);
    expect(Object.keys(store.model.projects)).toEqual(["a", "b"]);
    store.close();
    expect(effectStatuses(home)).toEqual(["pending"]);
  });

  it("rolls back everything when any part of a commit fails", async () => {
    const home = await tempDir("store");
    const store = openEventStore(home, clock);
    const unserializable = { kind: "turn.run", threadId: "t1", turnId: 1n } as unknown as Effect;
    expect(() =>
      store.commit({ commandId: "c1", events: [projectAdded("a")], effects: [unserializable] }),
    ).toThrow(/BigInt/);
    expect(store.eventsAfter(0)).toEqual([]);
    expect(store.receipt("c1")).toBeNull();
    expect(store.model.seq).toBe(0);

    const retried = store.commit({ commandId: "c1", events: [projectAdded("a")], effects: [] });
    expect(retried.events[0]?.seq).toBe(1);
    store.close();
  });

  it("refuses a second receipt for the same command", async () => {
    const store = openEventStore(await tempDir("store"), clock);
    store.commit({ commandId: "c1", events: [projectAdded("a")], effects: [] });
    expect(() =>
      store.commit({ commandId: "c1", events: [projectAdded("b")], effects: [] }),
    ).toThrow(/UNIQUE/);
    expect(store.eventsAfter(0)).toHaveLength(1);
    expect(store.receipt("c1")).toEqual({ accepted: true, duplicate: false, seq: 1 });
    store.close();
  });

  it("replays to an identical read model after reopening", async () => {
    const home = await tempDir("store");
    const first = openEventStore(home, clock);
    first.commit({ commandId: "c1", events: [projectAdded("a")], effects: [] });
    first.appendInternal([projectAdded("b", null)]);
    first.commit({
      commandId: "c2",
      events: [{ type: "project.removed", commandId: "c2", projectId: "a" }],
      effects: [],
    });
    const before = first.model;
    first.close();

    const second = openEventStore(home, clock);
    expect(second.model).toEqual(before);
    expect(second.eventsAfter(1).map((event) => event.seq)).toEqual([2, 3]);
    expect(second.receipt("c2")).toEqual({ accepted: true, duplicate: false, seq: 3 });
    second.close();
  });

  it("retires pending effects and marks finished ones", async () => {
    const home = await tempDir("store");
    const store = openEventStore(home, clock);
    const { effects } = store.commit({
      commandId: "c1",
      events: [],
      effects: [
        { kind: "turn.run", threadId: "t1", turnId: "u1" },
        { kind: "turn.run", threadId: "t2", turnId: "u2" },
      ],
    });
    store.markEffect(effects[0]?.id ?? 0, "done");
    expect(store.retirePendingEffects()).toBe(1);
    store.close();
    expect(effectStatuses(home)).toEqual(["done", "retired"]);
  });

  it("fails loudly when a stored event does not decode", async () => {
    const home = await tempDir("store");
    openEventStore(home, clock).close();
    const db = new DatabaseSync(join(home, "state.sqlite"));
    db.prepare("INSERT INTO events (type, at, command_id, payload) VALUES (?, ?, ?, ?)").run(
      "project.added",
      clock(),
      "c1",
      JSON.stringify({ type: "project.added", commandId: "c1", project: { id: "a" } }),
    );
    db.close();
    expect(() => openEventStore(home, clock)).toThrow(/Stored event 1 does not decode/);
  });
});
