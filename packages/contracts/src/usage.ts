import { z } from "zod";
import { IsoTime, ProviderKind } from "./model.ts";

export const LimitWindow = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nullable(),
  resetsAt: IsoTime.nullable(),
});
export type LimitWindow = z.infer<typeof LimitWindow>;

export const ProviderLimits = z.object({
  provider: ProviderKind,
  available: z.boolean(),
  plan: z.string().nullable(),
  windows: z.array(LimitWindow),
  checkedAt: IsoTime,
  problem: z.string().nullable(),
});
export type ProviderLimits = z.infer<typeof ProviderLimits>;

/**
 * Where a history row was read from. Not ProviderKind: OpenCode is an origin,
 * and demo is not. Demo spend stays on Wooky turns.
 */
export const Origin = z.enum(["claude", "cursor", "codex", "opencode"]);
export type Origin = z.infer<typeof Origin>;

/** 1 is the past 24 hours (hourly buckets). The others are calendar-day windows. */
export const UsageWindowDays = z.literal([1, 7, 30, 90]);
export type UsageWindowDays = z.infer<typeof UsageWindowDays>;

function isIanaTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whatever `Intl` accepts. An invalid zone is a bad request, not a UTC fallback. */
export const IanaTimeZone = z.string().refine(isIanaTimeZone, "Expected an IANA time zone");
export type IanaTimeZone = z.infer<typeof IanaTimeZone>;

function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const UsageDay = z.string().refine(isCalendarDay, "Expected a calendar day YYYY-MM-DD");

export const UsageHistoryParams = z
  .object({
    windowDays: UsageWindowDays,
    timeZone: IanaTimeZone,
    origins: z.array(Origin).optional(),
    awaitRefresh: z.boolean().optional(),
  })
  .strict();
export type UsageHistoryParams = z.infer<typeof UsageHistoryParams>;

/** Dollars for one bucket, split by token class. `other` is cost that could not be split. */
export const UsageCostByType = z
  .object({
    input: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    output: z.number().nonnegative(),
    other: z.number().nonnegative(),
  })
  .strict();
export type UsageCostByType = z.infer<typeof UsageCostByType>;

/**
 * One aggregated cell. No path, session id, or raw record.
 * `inputTokens` is uncached input only.
 */
export const UsageHistoryBucket = z
  .object({
    day: UsageDay,
    hour: z.number().int().min(0).max(23).optional(),
    origin: Origin,
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative(),
    costByType: UsageCostByType,
    cacheSavingsUsd: z.number().nonnegative(),
    records: z.number().int().nonnegative(),
    unpricedRecords: z.number().int().nonnegative(),
  })
  .strict();
export type UsageHistoryBucket = z.infer<typeof UsageHistoryBucket>;

export const UsageHistorySource = z
  .object({
    origin: Origin,
    status: z.enum(["ok", "partial", "missing", "disabled", "failed"]),
    files: z.number().int().nonnegative(),
    distinctSessions: z.number().int().nonnegative(),
    refreshing: z.boolean(),
    note: z.string().optional(),
  })
  .strict();
export type UsageHistorySource = z.infer<typeof UsageHistorySource>;

export const UsageHistoryPricing = z
  .object({
    status: z.enum(["ok", "stale", "unavailable"]),
    asOf: IsoTime.optional(),
  })
  .strict();
export type UsageHistoryPricing = z.infer<typeof UsageHistoryPricing>;

/** Version 1 aggregate. Buckets and source totals only. */
export const UsageHistoryResult = z
  .object({
    version: z.literal(1),
    buckets: z.array(UsageHistoryBucket),
    sources: z.array(UsageHistorySource),
    pricing: UsageHistoryPricing,
    generatedAt: IsoTime,
  })
  .strict();
export type UsageHistoryResult = z.infer<typeof UsageHistoryResult>;
