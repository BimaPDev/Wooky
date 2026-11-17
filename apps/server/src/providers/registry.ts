import type { ProviderKind, ProviderStatus } from "@age/contracts";
import type { ProviderAdapter } from "./types.ts";

const LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  cursor: "Cursor Agent",
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

  const probe = async (adapter: ProviderAdapter): Promise<ProviderStatus> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("did not answer in time")), probeTimeoutMs);
    });
    try {
      return await Promise.race([adapter.probe(), timeout]);
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
