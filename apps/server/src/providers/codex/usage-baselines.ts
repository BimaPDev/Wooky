import type { UsageTotals } from "./translate.ts";

const DEFAULT_MAX_THREADS = 1_000;

/**
 * Cumulative token totals per native thread id, bounded so a long-running server
 * cannot grow it without limit. Reading or writing a thread marks it most recent
 * (Map insertion order), and the least recently used thread is evicted first.
 */
export function createUsageBaselineStore(maxThreads = DEFAULT_MAX_THREADS) {
  const totals = new Map<string, UsageTotals>();

  return {
    get(threadId: string): UsageTotals | null {
      const found = totals.get(threadId);
      if (!found) return null;
      totals.delete(threadId);
      totals.set(threadId, found);
      return found;
    },
    set(threadId: string, usage: UsageTotals): void {
      totals.delete(threadId);
      totals.set(threadId, usage);
      while (totals.size > maxThreads) {
        const oldest = totals.keys().next();
        if (oldest.done) break;
        totals.delete(oldest.value);
      }
    },
    size: () => totals.size,
  };
}
