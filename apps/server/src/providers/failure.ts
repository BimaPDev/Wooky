import type { TurnFailure, TurnFailureKind } from "@wooky/contracts";

export type { TurnFailure, TurnFailureKind };

const MESSAGE_MAX = 2000;

const INTERRUPT_RE =
  /\b(?:the turn was interrupted|user(?:-|\s+)(?:abort(?:ed)?|cancel(?:led|ed))|cancelled by the user|canceled by the user)\b|\binterrupted\b/i;

const AUTH_RE =
  /\b401(?:\s+unauthorized)?\b|\b403(?:\s+forbidden)?\b|\bnot (?:logged|signed) in\b|\binvalid api[_ -]?key\b|\bauthentication(?: is)? required\b|\bauthentication_failed\b|\bunauthenticated\b|\brun ['`]agent login['`]/i;

const OVERLOADED_RE =
  /\boverloaded\b|\b529\b|\b503(?:\s+service unavailable)?\b|\bservice unavailable\b/i;

const QUOTA_RE =
  /\busage[_ -]?limits?\b|\bexceeded your\s+(?:quota|limit|usage|plan|credit|maximum)\b|\b(?:quota exceeded|exceeded (?:your )?quota|over quota)\b|\bcredit balance\b|\bout of credits\b|\bbilling[_ -]?error\b|\badd billing\b|\bbilling (?:issue|limit)\b|\byou(?:['’]ve| have) (?:hit|reached) your (?:usage )?limit\b/i;

const RATE_LIMIT_RE =
  /\b429(?:\s+too many requests)?\b|\btoo many requests\b|\brate[_ -]?limits?(?:\b|_error)/i;

const RELATIVE_RE =
  /\b(?:try again|retry|reset(?:s)?)\s+in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;

const WALL_CLOCK_RE =
  /\b(?:reset(?:s)?\s+at|try again at|again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/;
const PIPE_EPOCH_RE = /\|(\d{9,13})\s*$/;
const EPOCH_RE = /\b(\d{10,13})\b/;
const RETRY_AFTER_SECONDS_RE = /retry-after:\s*(\d+)/i;
const RETRY_AFTER_VALUE_RE = /retry-after:\s*([^\r\n]+)/i;
const WHOLE_SECONDS_RE = /^\s*(\d+)\s*$/;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

export function parseRetryAfter(text: string, now?: Date): number | undefined {
  const whole = WHOLE_SECONDS_RE.exec(text);
  if (whole) return secondsToMs(whole[1]);

  const headerSeconds = RETRY_AFTER_SECONDS_RE.exec(text);
  if (headerSeconds) return secondsToMs(headerSeconds[1]);

  const headerValue = RETRY_AFTER_VALUE_RE.exec(text);
  if (!headerValue?.[1] || now === undefined) return undefined;
  const parsed = Date.parse(headerValue[1].trim());
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - now.getTime());
}

export function parseResetAt(text: string, now: Date): string | undefined {
  const iso = ISO_RE.exec(text);
  if (iso) {
    const parsed = Date.parse(iso[0]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  const piped = PIPE_EPOCH_RE.exec(text);
  const epoch = piped?.[1] ?? EPOCH_RE.exec(text)?.[1];
  if (epoch) {
    const isoFromEpoch = epochToIso(epoch);
    if (isoFromEpoch) return isoFromEpoch;
  }

  const relative = RELATIVE_RE.exec(text);
  if (relative?.[1] && relative[2]) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2].toLowerCase()];
    if (Number.isFinite(amount) && amount >= 0 && unit !== undefined) {
      return new Date(now.getTime() + amount * unit).toISOString();
    }
  }

  const wall = WALL_CLOCK_RE.exec(text);
  if (wall?.[1]) return wallClockToIso(now, wall[1], wall[2], wall[3]);

  return undefined;
}

export function classifyGenericText(text: string, now?: Date): TurnFailure | null {
  const message = text.trim();
  if (message === "") return null;
  if (INTERRUPT_RE.test(message)) return null;

  const clock = now ?? new Date();
  const timing = timingFrom(message, clock);

  if (AUTH_RE.test(message)) return ofKind("auth", message);
  if (OVERLOADED_RE.test(message)) return ofKind("overloaded", message, timing);
  if (QUOTA_RE.test(message)) return ofKind("quota", message, timing);
  if (RATE_LIMIT_RE.test(message)) return ofKind("rate_limit", message, timing);
  return null;
}

export function isInterruptText(text: string): boolean {
  return INTERRUPT_RE.test(text);
}

function ofKind(
  kind: TurnFailureKind,
  message: string,
  timing: Pick<TurnFailure, "resetAt" | "retryAfterMs"> = {},
): TurnFailure {
  return { kind, message, ...timing };
}

export function asDoneFailure(failure: TurnFailure | null): TurnFailure | undefined {
  if (!failure) return undefined;
  const message =
    failure.message.length <= MESSAGE_MAX ? failure.message : failure.message.slice(0, MESSAGE_MAX);
  const retryAfterMs =
    failure.retryAfterMs === undefined ? undefined : Math.round(Math.max(0, failure.retryAfterMs));
  return {
    kind: failure.kind,
    message,
    ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function timingFrom(text: string, now: Date): Pick<TurnFailure, "resetAt" | "retryAfterMs"> {
  const retryAfterMs = parseRetryAfter(text, now);
  const resetAt = parseResetAt(text, now);
  const out: Pick<TurnFailure, "resetAt" | "retryAfterMs"> = {};
  if (resetAt) out.resetAt = resetAt;
  else if (retryAfterMs !== undefined) {
    out.resetAt = new Date(now.getTime() + retryAfterMs).toISOString();
  }
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
  else if (resetAt) {
    const ms = Date.parse(resetAt) - now.getTime();
    if (Number.isFinite(ms) && ms >= 0) out.retryAfterMs = ms;
  }
  return out;
}

function secondsToMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1_000;
}

function epochToIso(raw: string): string | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const ms = value > 1e12 ? value : value * 1_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function wallClockToIso(
  now: Date,
  hourRaw: string,
  minuteRaw: string | undefined,
  ampmRaw: string | undefined,
): string | undefined {
  const hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  const ampm = ampmRaw?.toLowerCase();
  let hours24 = hour;
  if (ampm === "am" || ampm === "pm") {
    if (hour < 1 || hour > 12) return undefined;
    if (ampm === "am") hours24 = hour === 12 ? 0 : hour;
    else hours24 = hour === 12 ? 12 : hour + 12;
  } else if (hour < 0 || hour > 23) {
    return undefined;
  }

  const next = new Date(now.getTime());
  next.setHours(hours24, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
