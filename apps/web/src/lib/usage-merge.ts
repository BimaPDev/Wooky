import type {
  Origin,
  ProviderKind,
  Turn,
  UsageCostByType,
  UsageHistoryBucket,
  UsageHistorySource,
} from "@age/contracts";

export type UsageSeriesId = Origin | "demo";

export const USAGE_SERIES_ORDER: UsageSeriesId[] = [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "antigravity",
  "demo",
];

const ORIGIN_PROVIDER: Partial<Record<Origin, ProviderKind>> = {
  claude: "claude",
  cursor: "cursor",
  codex: "codex",
};

export function providerForOrigin(origin: Origin): ProviderKind | null {
  return ORIGIN_PROVIDER[origin] ?? null;
}

export function usesImportedHistory(status: UsageHistorySource["status"]): boolean {
  return status === "ok" || status === "partial";
}

export function turnProvidersFromSources(
  sources: readonly UsageHistorySource[],
): Set<ProviderKind> {
  const out = new Set<ProviderKind>(["demo"]);
  for (const source of sources) {
    const provider = providerForOrigin(source.origin);
    if (provider && !usesImportedHistory(source.status)) out.add(provider);
  }
  return out;
}

export function filterHistoryBuckets(
  buckets: readonly UsageHistoryBucket[],
  sources: readonly UsageHistorySource[],
): UsageHistoryBucket[] {
  const allowed = new Set<Origin>();
  for (const source of sources) {
    if (usesImportedHistory(source.status)) allowed.add(source.origin);
  }
  return buckets.filter((bucket) => allowed.has(bucket.origin));
}

export type TurnUsageRow = {
  id: string;
  provider: ProviderKind;
  model: string;
  startedAt: string;
  endedAt: string | null;
  usage: NonNullable<Turn["usage"]>;
};

export function collectTurnRows(
  turns: Record<string, Turn[]>,
  allowedProviders: ReadonlySet<ProviderKind>,
): TurnUsageRow[] {
  const rows: TurnUsageRow[] = [];
  for (const list of Object.values(turns)) {
    for (const turn of list) {
      if (!allowedProviders.has(turn.provider)) continue;
      if (!turn.usage) continue;
      rows.push({
        id: turn.id,
        provider: turn.provider,
        model: turn.model,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        usage: turn.usage,
      });
    }
  }
  return rows;
}

export function emptyCostByType(): UsageCostByType {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 };
}

export function seriesIdForProvider(provider: ProviderKind): UsageSeriesId {
  return provider;
}
