import type { ProviderKind, ProviderLimits } from "@age/contracts";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  applyClaudeRateLimitEvent,
  fetchClaudeLimits,
} from "../providers/claude/limits.ts";
import { fetchCodexLimits } from "../providers/codex/limits.ts";

const DEFAULT_CACHE_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export type LimitsProbe = () => Promise<ProviderLimits>;

export type LimitsServiceOptions = {
  now?: () => number;
  cacheTtlMs?: number;
  probeTimeoutMs?: number;
  probes?: Partial<Record<ProviderKind, LimitsProbe>>;
};

export type LimitsService = {
  get(options?: { refresh?: boolean }): Promise<ProviderLimits[]>;
  ingestClaudeRateLimit(info: SDKRateLimitInfo): void;
};

function unavailable(
  provider: ProviderKind,
  problem: string,
  checkedAt: string,
): ProviderLimits {
  return {
    provider,
    available: false,
    plan: null,
    windows: [],
    checkedAt,
    problem,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const STATIC_UNAVAILABLE: ReadonlyArray<{ provider: ProviderKind; problem: string }> = [
  { provider: "cursor", problem: "Cursor Agent does not report plan limits." },
  { provider: "demo", problem: "Demo does not report plan limits." },
];

export function createLimitsService(options: LimitsServiceOptions = {}): LimitsService {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes: Record<"claude" | "codex", LimitsProbe> = {
    claude: options.probes?.claude ?? (() => fetchClaudeLimits()),
    codex: options.probes?.codex ?? (() => fetchCodexLimits()),
  };

  let cached: ProviderLimits[] | null = null;
  let cachedAt = 0;
  let inflight: Promise<ProviderLimits[]> | null = null;

  const isoNow = () => new Date(now()).toISOString();

  async function probeAll(): Promise<ProviderLimits[]> {
    const checkedAt = isoNow();
    const [claude, codex] = await Promise.all([
      withTimeout(probes.claude(), probeTimeoutMs, "Claude limits probe").catch((error) =>
        unavailable(
          "claude",
          error instanceof Error ? error.message : "Could not read Claude plan limits.",
          checkedAt,
        ),
      ),
      withTimeout(probes.codex(), probeTimeoutMs, "Codex limits probe").catch((error) =>
        unavailable(
          "codex",
          error instanceof Error ? error.message : "Could not read Codex plan limits.",
          checkedAt,
        ),
      ),
    ]);

    return [
      claude,
      codex,
      ...STATIC_UNAVAILABLE.map(({ provider, problem }) =>
        unavailable(provider, problem, checkedAt),
      ),
    ];
  }

  async function get(params: { refresh?: boolean } = {}): Promise<ProviderLimits[]> {
    const refresh = params.refresh === true;
    if (!refresh && cached && now() - cachedAt < cacheTtlMs) return cached;
    if (!refresh && inflight) return inflight;

    const run = probeAll()
      .then((result) => {
        cached = result;
        cachedAt = now();
        return result;
      })
      .catch(() => {
        const checkedAt = isoNow();
        const fallback = [
          unavailable("claude", "Could not read Claude plan limits.", checkedAt),
          unavailable("codex", "Could not read Codex plan limits.", checkedAt),
          ...STATIC_UNAVAILABLE.map(({ provider, problem }) =>
            unavailable(provider, problem, checkedAt),
          ),
        ];
        cached = fallback;
        cachedAt = now();
        return fallback;
      })
      .finally(() => {
        inflight = null;
      });

    inflight = run;
    return run;
  }

  function ingestClaudeRateLimit(info: SDKRateLimitInfo): void {
    const checkedAt = isoNow();
    const existing = cached?.find((entry) => entry.provider === "claude") ?? null;
    const next = applyClaudeRateLimitEvent(existing, info, checkedAt);
    if (!cached) {
      cached = [
        next,
        unavailable("codex", "Codex plan limits have not been checked yet.", checkedAt),
        ...STATIC_UNAVAILABLE.map(({ provider, problem }) =>
          unavailable(provider, problem, checkedAt),
        ),
      ];
    } else {
      cached = cached.map((entry) => (entry.provider === "claude" ? next : entry));
    }
    cachedAt = now();
  }

  return { get, ingestClaudeRateLimit };
}
