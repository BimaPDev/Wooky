import type { ProviderKind, ProviderStatus } from "@age/contracts";
import { checkBinaryPath, withCustomModels, type ProviderSettingsSource } from "./settings.ts";
import type { ProviderAdapter } from "./types.ts";

const LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  demo: "Demo",
  opencode: "OpenCode",
  acp: "ACP agent",
};

export interface ProviderRegistry {
  get(kind: ProviderKind): ProviderAdapter | null;
  /** Probes every adapter (bounded by a timeout each) and caches the answer briefly. */
  list(): Promise<ProviderStatus[]>;
  /** Drop the cached answer so the next `list` probes again. Call after settings change. */
  invalidate(): void;
}

/** Kinds whose CLI path `ProviderSettings.binaryPath` replaces. */
const BINARY_OVERRIDE: ReadonlySet<ProviderKind> = new Set([
  "claude",
  "cursor",
  "codex",
  "opencode",
]);

export function createProviderRegistry(
  adapters: readonly ProviderAdapter[],
  {
    probeTimeoutMs = 5_000,
    cacheMs = 30_000,
    settings,
  }: { probeTimeoutMs?: number; cacheMs?: number; settings?: ProviderSettingsSource } = {},
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
    const own = settings?.(adapter.kind);
    const binaryPath = BINARY_OVERRIDE.has(adapter.kind) ? own?.binaryPath?.trim() : undefined;
    if (binaryPath) {
      const check = checkBinaryPath(binaryPath, LABELS[adapter.kind]);
      if (!check.ok) {
        return withCustomModels(
          {
            kind: adapter.kind,
            label: LABELS[adapter.kind],
            installed: false,
            authenticated: null,
            version: null,
            models: [],
            problem: check.problem,
          },
          own,
        );
      }
    }
    return withCustomModels(await probeAdapter(adapter), own);
  };

  const probeAdapter = async (adapter: ProviderAdapter): Promise<ProviderStatus> => {
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
    invalidate() {
      cached = null;
      unsettled.clear();
    },
    list() {
      const now = Date.now();
      if (!cached || now - cached.at > cacheMs)
        cached = { at: now, list: Promise.all(adapters.map(probe)) };
      return cached.list;
    },
  };
}
