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
  const ms = startOfCalendarDayMs(day, timeZone) + offset * 24 * 60 * 60 * 1000;
  return calendarDayKey(ms, timeZone);
}

function startOfCalendarDayMs(day: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return 0;
  const guess = Date.parse(`${day}T12:00:00Z`);
  const formatted = calendarDayKey(guess, timeZone);
  if (formatted === day) return guess - 12 * 60 * 60 * 1000;
  const parts = day.split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const date = parts[2] ?? 1;
  return Date.UTC(year, month - 1, date, 12, 0, 0);
}

function* iterateCalendarDays(first: string, last: string, timeZone: string): Iterable<string> {
  let current = first;
  while (true) {
    yield current;
    if (current === last) break;
    current = addCalendarDays(current, 1, timeZone);
  }
}
