import type { UsageWindowDays } from "@age/contracts";

export type UsageResolution = "hour" | "day";

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();
const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string) {
  const hit = dayFormatterCache.get(timeZone);
  if (hit) return hit;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  dayFormatterCache.set(timeZone, fmt);
  return fmt;
}

function partsFormatter(timeZone: string) {
  const hit = partsFormatterCache.get(timeZone);
  if (hit) return hit;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  partsFormatterCache.set(timeZone, fmt);
  return fmt;
}

export function calendarDayKey(ms: number, timeZone: string): string {
  return dayFormatter(timeZone).format(new Date(ms));
}

export function localHour(ms: number, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "0";
  return Number(hour);
}

export function windowBounds(
  windowDays: UsageWindowDays,
  nowMs: number,
  timeZone: string,
): { sinceMs: number; untilMs: number; resolution: UsageResolution } {
  if (windowDays === 1) {
    return { sinceMs: nowMs - 24 * 60 * 60 * 1000, untilMs: nowMs, resolution: "hour" };
  }
  const today = calendarDayKey(nowMs, timeZone);
  const startDay = addCalendarDays(today, -(windowDays - 1), timeZone);
  const sinceMs = startOfCalendarDayMs(startDay, timeZone);
  return { sinceMs, untilMs: nowMs, resolution: "day" };
}

export function enumeratePeriodKeys(
  sinceMs: number,
  untilMs: number,
  resolution: UsageResolution,
  timeZone: string,
): string[] {
  const keys: string[] = [];
  if (resolution === "hour") {
    const start = new Date(sinceMs);
    start.setMinutes(0, 0, 0);
    for (let t = start.getTime(); t <= untilMs; t += 60 * 60 * 1000) {
      keys.push(periodKeyForMs(t, resolution, timeZone));
    }
    return keys;
  }
  const first = calendarDayKey(sinceMs, timeZone);
  const last = calendarDayKey(untilMs, timeZone);
  for (const key of iterateCalendarDays(first, last, timeZone)) keys.push(key);
  return keys;
}

export function periodKeyForMs(ms: number, resolution: UsageResolution, timeZone: string): string {
  if (resolution === "day") return calendarDayKey(ms, timeZone);
  const day = calendarDayKey(ms, timeZone);
  const hour = String(localHour(ms, timeZone)).padStart(2, "0");
  return `${day}T${hour}`;
}

export function bucketPeriodKey(
  bucket: { day: string; hour?: number },
  resolution: UsageResolution,
): string {
  if (resolution === "hour") {
    const hour = bucket.hour ?? 0;
    return `${bucket.day}T${String(hour).padStart(2, "0")}`;
  }
  return bucket.day;
}

export function formatPeriodLabel(key: string, resolution: UsageResolution): string {
  if (resolution === "hour") {
    const hour = Number(key.slice(11, 13));
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12} ${suffix}`;
  }
  const date = new Date(`${key}T12:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function addCalendarDays(day: string, offset: number, timeZone: string): string {
  if (offset === 0) return day;
  let current = day;
  const step = offset > 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(offset); i += 1) {
    current = stepCalendarDay(current, timeZone, step);
  }
  return current;
}

/** Any instant that falls on this local calendar day (for stepping, not necessarily midnight). */
function momentOnCalendarDay(day: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const anchor = Date.UTC(year, month - 1, date, 12, 0, 0);
  for (let hours = -36; hours <= 36; hours += 1) {
    const ms = anchor + hours * 60 * 60 * 1000;
    if (calendarDayKey(ms, timeZone) === day) return ms;
  }
  return anchor;
}

function stepCalendarDay(day: string, timeZone: string, dir: 1 | -1): string {
  const anchor = momentOnCalendarDay(day, timeZone);
  for (let hours = 1; hours <= 48; hours += 1) {
    const next = calendarDayKey(anchor + dir * hours * 60 * 60 * 1000, timeZone);
    if (next !== day) return next;
  }
  return day;
}

function startOfCalendarDayMs(day: string, timeZone: string): number {
  const anchor = momentOnCalendarDay(day, timeZone);
  for (let hours = 0; hours <= 27; hours += 1) {
    if (calendarDayKey(anchor - hours * 60 * 60 * 1000, timeZone) !== day) {
      return anchor - (hours - 1) * 60 * 60 * 1000;
    }
  }
  return anchor - 27 * 60 * 60 * 1000;
}

function* iterateCalendarDays(first: string, last: string, timeZone: string): Iterable<string> {
  let current = first;
  while (true) {
    yield current;
    if (current === last) break;
    current = addCalendarDays(current, 1, timeZone);
  }
}
