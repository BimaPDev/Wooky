import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgeEvent, type PendingEvent, type ReadModel, type RpcResult } from "@wooky/contracts";
import { applyEvents, emptyReadModel } from "@wooky/domain";
import type { Effect, StoredEffect } from "../orchestrator/effects.ts";

export type DispatchResult = RpcResult<"dispatch">;
type Listener = (events: readonly AgeEvent[]) => void;

export interface EventStore {
  readonly model: ReadModel;
  commit(input: { commandId: string; events: PendingEvent[]; effects: Effect[] }): {
    events: AgeEvent[];
    effects: StoredEffect[];
    result: DispatchResult;
  };
  /** Events produced by effects; they have no command. */
  appendInternal(events: PendingEvent[]): AgeEvent[];
  receipt(commandId: string): DispatchResult | null;
  eventsAfter(seq: number): AgeEvent[];
  markEffect(id: number, status: "done" | "retired"): void;
  /** Effects a previous process committed but never finished, oldest first. */
  pendingEffects(): StoredEffect[];
  /** Append replica events from a peer owner (ignores duplicate owner/seq). */
  appendReplicaEvents(ownerDeviceId: string, events: readonly AgeEvent[]): number;
  replicaEventsAfter(ownerDeviceId: string, since: number): AgeEvent[];
  /** The highest owner seq ever received. It survives pruning so pruned events are not pulled again. */
  replicaHighWater(ownerDeviceId: string): number;
  replicaOwners(): string[];
  dropReplicaOwner(ownerDeviceId: string): number;
  dropReplicaThreads(ownerDeviceId: string, threadIds: readonly string[]): number;
  claimCheckpoints(): { claimId: string; releasedAt: string }[];
  /** Durable checkpoint recording that the owner already released a claim's thread. */
  markClaimReleased(claimId: string): void;
  isClaimReleased(claimId: string): boolean;
  clearClaimReleased(claimId: string): void;
  subscribe(listener: Listener): () => void;
  close(): void;
}

interface EventRow {
  seq: number;
  at: string;
  payload: string;
}

/** Event store over node:sqlite at `<home>/state.sqlite`. Every write is one transaction. */
export function openEventStore(home: string, clock: () => string): EventStore {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      command_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      command_id TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'retired'))
    );
    CREATE TABLE IF NOT EXISTS replica_events (
      owner_device_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (owner_device_id, seq)
    );
    CREATE TABLE IF NOT EXISTS replica_cursors (
      owner_device_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claim_checkpoints (
      claim_id TEXT PRIMARY KEY,
      released_at TEXT NOT NULL
    );
  `);

  const insertEvent = db.prepare(
    "INSERT INTO events (type, at, command_id, payload) VALUES (?, ?, ?, ?)",
  );
  const insertReceipt = db.prepare(
    "INSERT INTO receipts (command_id, result, at) VALUES (?, ?, ?)",
  );
  const insertEffect = db.prepare(
    "INSERT INTO effects (created_seq, kind, payload, status) VALUES (?, ?, ?, 'pending')",
  );
  const selectReceipt = db.prepare("SELECT result FROM receipts WHERE command_id = ?");
  const selectAfter = db.prepare("SELECT seq, at, payload FROM events WHERE seq > ? ORDER BY seq");
  const updateEffect = db.prepare("UPDATE effects SET status = ? WHERE id = ?");
  const selectPending = db.prepare(
    "SELECT id, payload FROM effects WHERE status = 'pending' ORDER BY id",
  );
  const insertReplica = db.prepare(
    "INSERT OR IGNORE INTO replica_events (owner_device_id, seq, event_json) VALUES (?, ?, ?)",
  );
  const selectReplicaAfter = db.prepare(
    "SELECT seq, event_json FROM replica_events WHERE owner_device_id = ? AND seq > ? ORDER BY seq",
  );
  const selectReplicaHighWater = db.prepare(
    `SELECT MAX(
       COALESCE((SELECT seq FROM replica_cursors WHERE owner_device_id = ?1), 0),
       COALESCE((SELECT MAX(seq) FROM replica_events WHERE owner_device_id = ?1), 0)
     ) AS maxSeq`,
  );
  const upsertReplicaCursor = db.prepare(
    `INSERT INTO replica_cursors (owner_device_id, seq) VALUES (?1, ?2)
     ON CONFLICT(owner_device_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
  );
  const selectReplicaOwners = db.prepare(
    "SELECT DISTINCT owner_device_id AS id FROM replica_events",
  );
  const deleteReplicaOwner = db.prepare("DELETE FROM replica_events WHERE owner_device_id = ?");
  const deleteReplicaThread = db.prepare(
    `DELETE FROM replica_events WHERE owner_device_id = ?1
       AND COALESCE(json_extract(event_json, '$.threadId'), json_extract(event_json, '$.thread.id')) = ?2`,
  );
  const selectClaimCheckpoints = db.prepare(
    "SELECT claim_id AS claimId, released_at AS releasedAt FROM claim_checkpoints",
  );
  const insertClaimReleased = db.prepare(
    "INSERT OR IGNORE INTO claim_checkpoints (claim_id, released_at) VALUES (?, ?)",
  );
  const selectClaimReleased = db.prepare("SELECT 1 FROM claim_checkpoints WHERE claim_id = ?");
  const deleteClaimReleased = db.prepare("DELETE FROM claim_checkpoints WHERE claim_id = ?");

  const decode = (row: EventRow): AgeEvent => {
    const parsed = AgeEvent.safeParse({ ...JSON.parse(row.payload), seq: row.seq, at: row.at });
    if (!parsed.success)
      throw new Error(`Stored event ${row.seq} does not decode: ${parsed.error.message}`);
    return parsed.data;
  };
  const eventsAfter = (seq: number) => (selectAfter.all(seq) as unknown as EventRow[]).map(decode);

  let model: ReadModel;
  try {
    model = applyEvents(emptyReadModel(), eventsAfter(0));
  } catch (error) {
    db.close();
    throw error;
  }
  const listeners = new Set<Listener>();

  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const insertEvents = (pending: PendingEvent[]): AgeEvent[] => {
    const at = clock();
    return pending.map((event) => {
      // Validate before writing: one undecodable row would stop the store from ever reopening.
      const checked = AgeEvent.safeParse({ ...event, seq: model.seq + 1, at });
      if (!checked.success)
        throw new Error(
          `Refusing to store an invalid ${event.type} event: ${checked.error.message}`,
        );
      const { lastInsertRowid } = insertEvent.run(
        event.type,
        at,
        event.commandId,
        JSON.stringify(event),
      );
      return { ...event, seq: Number(lastInsertRowid), at } as AgeEvent;
    });
  };

  const publish = (events: AgeEvent[]) => {
    if (events.length === 0) return;
    model = applyEvents(model, events);
    for (const listener of listeners) {
      try {
        listener(events);
      } catch (error) {
        console.error("Event subscriber failed", error);
      }
    }
  };

  return {
    get model() {
      return model;
    },
    commit({ commandId, events, effects }) {
      const committed = transaction(() => {
        const written = insertEvents(events);
        const seq = written.at(-1)?.seq ?? model.seq;
        const stored = effects.map((effect): StoredEffect => {
          const { lastInsertRowid } = insertEffect.run(seq, effect.kind, JSON.stringify(effect));
          return { ...effect, id: Number(lastInsertRowid) };
        });
        const result: DispatchResult = { accepted: true, duplicate: false, seq };
        insertReceipt.run(commandId, JSON.stringify(result), clock());
        return { events: written, effects: stored, result };
      });
      publish(committed.events);
      return committed;
    },
    appendInternal(events) {
      const written = transaction(() => insertEvents(events));
      publish(written);
      return written;
    },
    receipt(commandId) {
      const row = selectReceipt.get(commandId) as { result: string } | undefined;
      return row ? (JSON.parse(row.result) as DispatchResult) : null;
    },
    eventsAfter,
    markEffect(id, status) {
      updateEffect.run(status, id);
    },
    pendingEffects() {
      const rows = selectPending.all() as unknown as { id: number; payload: string }[];
      return rows.map((row) => ({ ...(JSON.parse(row.payload) as Effect), id: row.id }));
    },
    appendReplicaEvents(ownerDeviceId, events) {
      let added = 0;
      transaction(() => {
        for (const event of events) {
          const { changes } = insertReplica.run(ownerDeviceId, event.seq, JSON.stringify(event));
          if (changes) added += 1;
          upsertReplicaCursor.run(ownerDeviceId, event.seq);
        }
      });
      return added;
    },
    replicaEventsAfter(ownerDeviceId, since) {
      const rows = selectReplicaAfter.all(ownerDeviceId, since) as {
        seq: number;
        event_json: string;
      }[];
      return rows.flatMap((row) => {
        const parsed = AgeEvent.safeParse({ ...JSON.parse(row.event_json), seq: row.seq });
        if (!parsed.success) {
          console.warn(`Skipping replica event ${ownerDeviceId}/${row.seq}: it does not decode`);
          return [];
        }
        return [parsed.data];
      });
    },
    replicaHighWater(ownerDeviceId) {
      const row = selectReplicaHighWater.get(ownerDeviceId) as
        { maxSeq: number | null } | undefined;
      return row?.maxSeq ?? 0;
    },
    replicaOwners() {
      return (selectReplicaOwners.all() as { id: string }[]).map((row) => row.id);
    },
    dropReplicaOwner(ownerDeviceId) {
      return Number(deleteReplicaOwner.run(ownerDeviceId).changes);
    },
    dropReplicaThreads(ownerDeviceId, threadIds) {
      let removed = 0;
      transaction(() => {
        for (const id of threadIds)
          removed += Number(deleteReplicaThread.run(ownerDeviceId, id).changes);
      });
      return removed;
    },
    claimCheckpoints() {
      return selectClaimCheckpoints.all() as { claimId: string; releasedAt: string }[];
    },
    markClaimReleased(claimId) {
      insertClaimReleased.run(claimId, clock());
    },
    isClaimReleased(claimId) {
      return selectClaimReleased.get(claimId) !== undefined;
    },
    clearClaimReleased(claimId) {
      deleteClaimReleased.run(claimId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      db.close();
    },
  };
}
