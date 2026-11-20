import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openEventStore } from "./event-store.ts";
import { tempDir } from "../testing.ts";

const clock = () => "2026-01-01T00:00:00.000Z";

describe("replica_events migration", () => {
  it("upgrades an old database without the replica table", async () => {
    const home = await tempDir("replica-migrate");
    const legacy = new DatabaseSync(join(home, "state.sqlite"));
    legacy.exec(`
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        command_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE receipts (
        command_id TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'retired'))
      );
    `);
    legacy.close();

    const store = openEventStore(home, clock);
    const event = {
      type: "thread.created" as const,
      commandId: null,
      thread: {
        id: "t1",
        projectId: "p1",
        title: "T",
        provider: "demo" as const,
        model: "demo",
        runtimeMode: "approve" as const,
        worktree: null,
        providerSessionId: null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        pullRequest: null,
        queue: [],
        status: "idle" as const,
        createdAt: clock(),
        updatedAt: clock(),
      },
    };
    store.appendInternal([event as Parameters<typeof store.appendInternal>[0][number]]);
    const stored = store.eventsAfter(0)[0];
    if (!stored) throw new Error("missing event");
    store.appendReplicaEvents("owner-a", [stored]);
    expect(store.replicaHighWater("owner-a")).toBe(stored.seq);
    expect(store.replicaEventsAfter("owner-a", 0)).toHaveLength(1);
    store.close();

    const db = new DatabaseSync(join(home, "state.sqlite"));
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'replica_events'")
      .get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe("replica_events");
  });
});
