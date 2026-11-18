import type {
  UsageCostByType,
  UsageHistoryBucket,
  UsageHistorySource,
  UsageWindowDays,
} from "@age/contracts";
import { sumCostByType } from "./usage-cost-by-type.ts";
import {
  bucketPeriodKey,
  enumeratePeriodKeys,
  formatPeriodLabel,
  periodKeyForMs,
  windowBounds,
  type UsageResolution,
} from "./usage-windows.ts";
import {
  emptyCostByType,
  filterHistoryBuckets,
  seriesIdForProvider,
  turnProvidersFromSources,
  USAGE_SERIES_ORDER,
  type TurnUsageRow,
  type UsageSeriesId,
} from "./usage-merge.ts";

export type UsagePeriodBucket = {
  key: string;
  label: string;
  costBySeries: Map<UsageSeriesId, number>;
  tokensBySeries: Map<UsageSeriesId, number>;
  costTotal: number;
  tokensTotal: number;
};

export type UsageProviderRow = {
  id: UsageSeriesId;
  cost: number;
  tokens: number;
  sessions: number;
};

export type UsageModelRow = {
  name: string;
  series: UsageSeriesId;
  cost: number;
  tokens: number;
};

export type UsageDashboardStats = {
  sessions: number;
  cost: number;
  tokens: number;
  inputTokens: number;
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cacheSavings: number;
  costByType: UsageCostByType;
  unpricedRecords: number;
  providers: UsageProviderRow[];
  models: UsageModelRow[];
  periods: UsagePeriodBucket[];
  resolution: UsageResolution;
};

export function buildUsageDashboardStats(input: {
  buckets: readonly UsageHistoryBucket[];
  sources: readonly UsageHistorySource[];
  turnRows: readonly TurnUsageRow[];
  windowDays: UsageWindowDays;
  timeZone: string;
  nowMs: number;
  hiddenSeries: ReadonlySet<UsageSeriesId>;
}): UsageDashboardStats {
  const { sinceMs, untilMs, resolution } = windowBounds(
    input.windowDays,
    input.nowMs,
    input.timeZone,
  );
  const imported = filterHistoryBuckets(input.buckets, input.sources);
  const turnProviders = turnProvidersFromSources(input.sources);
  const visibleTurns = input.turnRows.filter((row) => turnProviders.has(row.provider));

  const periodKeys = enumeratePeriodKeys(sinceMs, untilMs, resolution, input.timeZone);
  const periodMap = new Map<string, UsagePeriodBucket>(
    periodKeys.map((key) => [
      key,
      {
        key,
        label: formatPeriodLabel(key, resolution),
        costBySeries: new Map(),
        tokensBySeries: new Map(),
        costTotal: 0,
        tokensTotal: 0,
      },
    ]),
  );

  const bySeries = new Map<UsageSeriesId, UsageProviderRow>();
  const byModel = new Map<string, UsageModelRow>();
  const costSlices: UsageCostByType[] = [];
  let unpricedRecords = 0;
  let cacheSavings = 0;
  let uncachedInput = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;

  const addSeries = (id: UsageSeriesId, cost: number, tokens: number) => {
    const row = bySeries.get(id) ?? { id, cost: 0, tokens: 0, sessions: 0 };
    row.cost += cost;
    row.tokens += tokens;
    bySeries.set(id, row);
  };

  const addModel = (series: UsageSeriesId, model: string, cost: number, tokens: number) => {
    const key = `${series}:${model}`;
    const row = byModel.get(key) ?? { name: model, series, cost: 0, tokens: 0 };
    row.cost += cost;
    row.tokens += tokens;
    byModel.set(key, row);
  };

  for (const bucket of imported) {
    if (input.hiddenSeries.has(bucket.origin)) continue;
    const tokens = bucketTokens(bucket);
    const period = periodMap.get(bucketPeriodKey(bucket, resolution));
    addSeries(bucket.origin, bucket.costUsd, tokens);
    addModel(bucket.origin, bucket.model, bucket.costUsd, tokens);
    costSlices.push(bucket.costByType);
    unpricedRecords += bucket.unpricedRecords;
    cacheSavings += bucket.cacheSavingsUsd;
    uncachedInput += bucket.inputTokens;
    cacheRead += bucket.cacheReadTokens;
    cacheWrite += bucket.cacheWriteTokens;
    output += bucket.outputTokens;
    if (period) {
      period.costBySeries.set(
        bucket.origin,
        (period.costBySeries.get(bucket.origin) ?? 0) + bucket.costUsd,
      );
      period.tokensBySeries.set(
        bucket.origin,
        (period.tokensBySeries.get(bucket.origin) ?? 0) + tokens,
      );
      period.costTotal += bucket.costUsd;
      period.tokensTotal += tokens;
    }
  }

  for (const turn of visibleTurns) {
    if (input.hiddenSeries.has(seriesIdForProvider(turn.provider))) continue;
    const at = Date.parse(turn.endedAt ?? turn.startedAt);
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    const usage = turn.usage;
    const turnCost = usage.costUsd ?? 0;
    const turnIn = usage.inputTokens ?? 0;
    const turnOut = usage.outputTokens ?? 0;
    const turnCached = usage.cachedInputTokens ?? 0;
    const tokens = turnIn + turnOut;
    const series = seriesIdForProvider(turn.provider);
    addSeries(series, turnCost, tokens);
    addModel(series, turn.model, turnCost, tokens);
    costSlices.push({ ...emptyCostByType(), other: turnCost });
    uncachedInput += Math.max(0, turnIn - turnCached);
    cacheRead += turnCached;
    output += turnOut;
    const period = periodMap.get(periodKeyForMs(at, resolution, input.timeZone));
    if (period) {
      period.costBySeries.set(series, (period.costBySeries.get(series) ?? 0) + turnCost);
      period.tokensBySeries.set(series, (period.tokensBySeries.get(series) ?? 0) + tokens);
      period.costTotal += turnCost;
      period.tokensTotal += tokens;
    }
    const row = bySeries.get(series);
    if (row) row.sessions += 1;
  }

  for (const source of input.sources) {
    if (input.hiddenSeries.has(source.origin)) continue;
    if (!usesImportedSessions(source)) continue;
    const row = bySeries.get(source.origin) ?? {
      id: source.origin,
      cost: 0,
      tokens: 0,
      sessions: 0,
    };
    row.sessions = source.distinctSessions;
    bySeries.set(source.origin, row);
  }

  const providers = USAGE_SERIES_ORDER.flatMap((id) => {
    const row = bySeries.get(id);
    return row && (row.cost > 0 || row.tokens > 0 || row.sessions > 0) ? [row] : [];
  });
  const cost = providers.reduce((sum, row) => sum + row.cost, 0);
  const inputTokens = uncachedInput + cacheRead + cacheWrite;
  const tokens = inputTokens + output;
  const sessions = providers.reduce((sum, row) => sum + row.sessions, 0);

  return {
    sessions,
    cost,
    tokens,
    inputTokens,
    uncachedInput,
    cacheRead,
    cacheWrite,
    output,
    cacheSavings,
    costByType: sumCostByType(costSlices),
    unpricedRecords,
    providers,
    models: [...byModel.values()].toSorted((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    periods: periodKeys.flatMap((key) => {
      const period = periodMap.get(key);
      return period ? [period] : [];
    }),
    resolution,
  };
}

export function bucketTokens(bucket: UsageHistoryBucket): number {
  return (
    bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens
  );
}

function usesImportedSessions(source: UsageHistorySource): boolean {
  return source.status === "ok" || source.status === "partial";
}
