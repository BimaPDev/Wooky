import type { FleetStatus, ReadModel } from "@age/contracts";
import { fleetRows } from "@age/domain";
import type { EventStore } from "../store/event-store.ts";

const TERMINAL: ReadonlySet<FleetStatus> = new Set(["done", "failed"]);

function partition(
  model: ReadModel,
  threadIds: readonly string[],
): { finished: string[]; pending: string[] } {
  const rows = new Map(fleetRows(model).map((row) => [row.threadId, row.status]));
  const finished: string[] = [];
  const pending: string[] = [];
  for (const threadId of threadIds) {
    const status = rows.get(threadId);
    if (!status || TERMINAL.has(status)) finished.push(threadId);
    else pending.push(threadId);
  }
  return { finished, pending };
}

/** Resolves when every thread is done or failed, or when timeoutMs elapses. */
export function waitForAgentThreads(
  store: EventStore,
  threadIds: readonly string[],
  timeoutMs: number,
): Promise<{ finished: string[]; pending: string[] }> {
  const initial = partition(store.model, threadIds);
  if (initial.pending.length === 0) return Promise.resolve(initial);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { finished: string[]; pending: string[] }) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(result);
    };

    const check = () => {
      const next = partition(store.model, threadIds);
      if (next.pending.length === 0) finish(next);
    };

    const unsubscribe = store.subscribe(() => check());
    check();

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(partition(store.model, threadIds));
          }, timeoutMs)
        : undefined;
  });
}
