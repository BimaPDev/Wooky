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
