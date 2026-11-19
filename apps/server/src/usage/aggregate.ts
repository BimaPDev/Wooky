import type { Origin, UsageHistoryBucket, UsageWindowDays } from "@age/contracts";
import type { HistoryRecord } from "./history-reader.ts";
import type { Pricer } from "./pricing.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Every real UTC offset is a multiple of 15 minutes, so a slot has one local label. */
const SLOT_MS = 15 * 60 * 1000;

/**
 * Collapses records that share a `dedupeKey` (Claude repeats a key per content block)
 * to the max of each token channel. Records without a key are all kept. Pure.
 */
export function dedupeRecords(records: readonly HistoryRecord[]): HistoryRecord[] {
  const out: HistoryRecord[] = [];
  const seen = new Map<string, HistoryRecord>();
  for (const record of records) {
    if (record.dedupeKey === undefined) {
      out.push(record);
      continue;
    }
    const key = `${record.origin}\u0000${record.dedupeKey}`;
    const first = seen.get(key);
    if (first === undefined) {
      const copy = { ...record };
      seen.set(key, copy);
      out.push(copy);
      continue;
    }
    first.inputTokens = Math.max(first.inputTokens, record.inputTokens);
    first.cacheReadTokens = Math.max(first.cacheReadTokens, record.cacheReadTokens);
    first.cacheWriteTokens = Math.max(first.cacheWriteTokens, record.cacheWriteTokens);
    first.outputTokens = Math.max(first.outputTokens, record.outputTokens);
    if (record.cacheWrite1hTokens !== undefined)
      first.cacheWrite1hTokens = Math.max(first.cacheWrite1hTokens ?? 0, record.cacheWrite1hTokens);
    if (record.reasoningTokens !== undefined)
      first.reasoningTokens = Math.max(first.reasoningTokens ?? 0, record.reasoningTokens);
    if (record.reportedCostUsd !== undefined)
      first.reportedCostUsd = Math.max(first.reportedCostUsd ?? 0, record.reportedCostUsd);
  }
  return out;
}

interface Label {
  day: string;
  hourKey: string;
  hour: number;
}

/** Local day and hour of an instant in `timeZone`, memoised per 15-minute slot. */
function createLabeler(timeZone: string): (at: number) => Label {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });
  const memo = new Map<number, Label>();
  return (at) => {
    const slot = Math.floor(at / SLOT_MS);
    let label = memo.get(slot);
    if (label === undefined) {
      const parts: Record<string, string> = {};
      for (const part of format.formatToParts(slot * SLOT_MS)) parts[part.type] = part.value;
      const hour = Number(parts.hour) % 24;
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      label = { day, hour, hourKey: `${day}T${String(hour).padStart(2, "0")}` };
      memo.set(slot, label);
    }
    return label;
  };
}

function addDays(day: string, delta: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10);
}

const tokens = (value: number) => (value > 0 && value < 1e15 ? Math.trunc(value) : 0);

interface Cell {
  day: string;
  hour: number | undefined;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: { input: number; cacheRead: number; cacheWrite: number; output: number; other: number };
  savings: number;
  records: number;
  unpriced: number;
}

export interface AggregateOptions {
  windowDays: UsageWindowDays;
  /** IANA zone. Days and hours are local to it. */
  timeZone: string;
  nowMs: number;
  price: Pricer;
  /** Only these origins. Default all. */
  origins?: readonly Origin[];
}

export interface Aggregated {
  buckets: UsageHistoryBucket[];
  /** Distinct session keys per origin over the window. The keys never leave this function. */
  distinctSessions: Partial<Record<Origin, number>>;
}

/**
 * Buckets already-deduped records by local calendar day (by local hour for the 24-hour
 * window) per origin and model, and prices them. Pure and O(records).
 */
export function aggregate(
  records: readonly HistoryRecord[],
  options: AggregateOptions,
): Aggregated {
  const { windowDays, nowMs, price } = options;
  const hourly = windowDays === 1;
  const label = createLabeler(options.timeZone);
  const today = label(nowMs).day;
  const firstDay = addDays(today, -(windowDays - 1));
  const wanted = options.origins === undefined ? null : new Set<Origin>(options.origins);

  const cells = new Map<Origin, Map<string, Map<string, Cell>>>();
  const sessions = new Map<Origin, Set<string>>();

  for (const record of records) {
    if (wanted !== null && !wanted.has(record.origin)) continue;
    const local = label(record.at);
    if (hourly) {
      if (record.at < nowMs - DAY_MS || record.at > nowMs) continue;
    } else if (local.day < firstDay || local.day > today) continue;

    let byModel = cells.get(record.origin);
    if (byModel === undefined) {
      byModel = new Map();
      cells.set(record.origin, byModel);
    }
    let byDay = byModel.get(record.model);
    if (byDay === undefined) {
      byDay = new Map();
      byModel.set(record.model, byDay);
    }
    const key = hourly ? local.hourKey : local.day;
    let cell = byDay.get(key);
    if (cell === undefined) {
      cell = {
        day: local.day,
        hour: hourly ? local.hour : undefined,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 },
        savings: 0,
        records: 0,
        unpriced: 0,
      };
      byDay.set(key, cell);
    }

    const input = tokens(record.inputTokens);
    const cacheRead = tokens(record.cacheReadTokens);
    const cacheWrite = tokens(record.cacheWriteTokens);
    const output = tokens(record.outputTokens);
    const priced = price(
      record.model,
      input,
      cacheRead,
      cacheWrite,
      output,
      record.reportedCostUsd,
      tokens(record.cacheWrite1hTokens ?? 0),
    );
    cell.input += input;
    cell.cacheRead += cacheRead;
    cell.cacheWrite += cacheWrite;
    cell.output += output;
    cell.reasoning += tokens(record.reasoningTokens ?? 0);
    cell.cost.input += priced.input;
    cell.cost.cacheRead += priced.cacheRead;
    cell.cost.cacheWrite += priced.cacheWrite;
    cell.cost.output += priced.output;
    cell.cost.other += priced.other;
    cell.savings += priced.savings;
    cell.records += 1;
    if (!priced.priced) cell.unpriced += 1;

    let set = sessions.get(record.origin);
    if (set === undefined) {
      set = new Set();
      sessions.set(record.origin, set);
    }
    set.add(record.sessionKey);
  }

  const buckets: UsageHistoryBucket[] = [];
  for (const [origin, byModel] of cells) {
    for (const [model, byDay] of byModel) {
      for (const cell of byDay.values()) {
        const { cost } = cell;
        const bucket: UsageHistoryBucket = {
          day: cell.day,
          origin,
          model,
          inputTokens: cell.input,
          cacheReadTokens: cell.cacheRead,
          cacheWriteTokens: cell.cacheWrite,
          outputTokens: cell.output,
          costUsd: cost.input + cost.cacheRead + cost.cacheWrite + cost.output + cost.other,
          costByType: cost,
          cacheSavingsUsd: cell.savings,
          records: cell.records,
          unpricedRecords: cell.unpriced,
        };
        if (cell.hour !== undefined) bucket.hour = cell.hour;
        if (cell.reasoning > 0) bucket.reasoningTokens = cell.reasoning;
        buckets.push(bucket);
      }
    }
  }
  buckets.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      (a.hour ?? 0) - (b.hour ?? 0) ||
      a.origin.localeCompare(b.origin) ||
      a.model.localeCompare(b.model),
  );

  const distinctSessions: Partial<Record<Origin, number>> = {};
  for (const [origin, set] of sessions) distinctSessions[origin] = set.size;
  return { buckets, distinctSessions };
}
