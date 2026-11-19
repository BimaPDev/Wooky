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

/** Resolves when every thread is done or failed, or when timeoutMs elapses or the signal aborts. */
export function waitForAgentThreads(
  store: EventStore,
  threadIds: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ finished: string[]; pending: string[] }> {
  const initial = partition(store.model, threadIds);
  if (initial.pending.length === 0) return Promise.resolve(initial);
  if (signal?.aborted) return Promise.resolve(partition(store.model, threadIds));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { finished: string[]; pending: string[] }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const check = () => {
      const next = partition(store.model, threadIds);
      if (next.pending.length === 0) finish(next);
    };

    const unsubscribe = store.subscribe(() => check());
    const onAbort = () => finish(partition(store.model, threadIds));
    const timer = setTimeout(() => finish(partition(store.model, threadIds)), timeoutMs);

    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}
