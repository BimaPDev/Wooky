import type { ProviderKind, ProviderStatus } from "@age/contracts";
import type { ProviderAdapter } from "./types.ts";

const LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  demo: "Demo",
};

export interface ProviderRegistry {
  get(kind: ProviderKind): ProviderAdapter | null;
  /** Probes every adapter (bounded by a timeout each) and caches the answer briefly. */
  list(): Promise<ProviderStatus[]>;
}

export function createProviderRegistry(
  adapters: readonly ProviderAdapter[],
  { probeTimeoutMs = 5_000, cacheMs = 30_000 } = {},
): ProviderRegistry {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  let cached: { at: number; list: Promise<ProviderStatus[]> } | null = null;
  const unsettled = new Map<ProviderKind, Promise<ProviderStatus>>();

  /** A probe that outlives its timeout is reused, never stacked under a new one. */
  const start = (adapter: ProviderAdapter): Promise<ProviderStatus> => {
    const running = unsettled.get(adapter.kind);
    if (running) return running;
    let probe: Promise<ProviderStatus>;
    try {
      probe = Promise.resolve(adapter.probe());
    } catch (error) {
      probe = Promise.reject(error);
    }
    const clear = () => {
      if (unsettled.get(adapter.kind) === probe) unsettled.delete(adapter.kind);
    };
    probe.then(clear, clear);
    unsettled.set(adapter.kind, probe);
    return probe;
  };

  const probe = async (adapter: ProviderAdapter): Promise<ProviderStatus> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("did not answer in time")), probeTimeoutMs);
    });
    try {
      return await Promise.race([start(adapter), timeout]);
    } catch (error) {
      return {
        kind: adapter.kind,
        label: LABELS[adapter.kind],
        installed: false,
        authenticated: null,
        version: null,
        models: [],
        problem: `Could not check ${LABELS[adapter.kind]}: ${error instanceof Error ? error.message : String(error)}.`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get: (kind) => byKind.get(kind) ?? null,
    list() {
      const now = Date.now();
      if (!cached || now - cached.at > cacheMs)
        cached = { at: now, list: Promise.all(adapters.map(probe)) };
      return cached.list;
    },
  };
}
