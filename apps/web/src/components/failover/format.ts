import type {
  ModelTarget,
  ProviderCooldown,
  ProviderKind,
  ProviderStatus,
  Turn,
  TurnFailure,
  TurnFailureKind,
} from "@age/contracts";
import { isAvailable, modelLabel } from "../labels.ts";

export const providerName: Record<ProviderKind, string> = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  demo: "Demo",
};

export interface ClockFormat {
  locale?: string;
  timeZone?: string;
}

export const sameTarget = (a: ModelTarget, b: ModelTarget) =>
  a.provider === b.provider && a.model === b.model;

export const targetOf = (value: { provider: ProviderKind; model: string }): ModelTarget => ({
  provider: value.provider,
  model: value.model,
});

export function targetLabel(providers: ProviderStatus[], target: ModelTarget): string {
  return `${providerName[target.provider]} · ${modelLabel(providers, target.provider, target.model)}`;
}

function dayKey(date: Date, fmt: ClockFormat): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(fmt.timeZone ? { timeZone: fmt.timeZone } : {}),
  }).format(date);
}

/** "3:00 PM", with a weekday in front when the time is not today. */
export function clockLabel(iso: string, nowMs: number, fmt: ClockFormat = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const zone = fmt.timeZone ? { timeZone: fmt.timeZone } : {};
  const time = new Intl.DateTimeFormat(fmt.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...zone,
  }).format(date);
  if (dayKey(date, fmt) === dayKey(new Date(nowMs), fmt)) return time;
  const day = new Intl.DateTimeFormat(fmt.locale, { weekday: "short", ...zone }).format(date);
  return `${day} ${time}`;
}

/** "in 12 min", "in 2 h 5 min", "in 3 days". */
export function relativeLabel(iso: string, nowMs: number): string {
  const diff = Date.parse(iso) - nowMs;
  if (Number.isNaN(diff) || diff <= 0) return "now";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

export function limitedUntilLabel(iso: string, nowMs: number, fmt: ClockFormat = {}): string {
  return `Limited until ${clockLabel(iso, nowMs, fmt)}`;
}

const keyFor = (target: ModelTarget) => `${target.provider}/${target.model}`;

/** The cooldown that blocks this target right now, provider-wide or model-specific. */
export function cooldownFor(
  cooldowns: Readonly<Record<string, ProviderCooldown>>,
  target: ModelTarget,
  nowMs: number,
): ProviderCooldown | null {
  const found = [cooldowns[target.provider], cooldowns[keyFor(target)]].filter(
    (entry): entry is ProviderCooldown => entry !== undefined && Date.parse(entry.until) > nowMs,
  );
  if (found.length === 0) return null;
  return found.reduce((latest, entry) =>
    Date.parse(entry.until) > Date.parse(latest.until) ? entry : latest,
  );
}

export interface CooldownRow {
  key: string;
  label: string;
  until: string;
  reason: TurnFailureKind;
}

/** Active cooldowns, soonest to clear first, labelled with a provider or provider and model. */
export function activeCooldowns(
  cooldowns: Readonly<Record<string, ProviderCooldown>>,
  providers: ProviderStatus[],
  nowMs: number,
): CooldownRow[] {
  return Object.entries(cooldowns)
    .filter(([, entry]) => Date.parse(entry.until) > nowMs)
    .map(([key, entry]) => {
      const [provider, ...rest] = key.split("/");
      const kind = provider as ProviderKind;
      const model = rest.join("/");
      const label =
        provider && provider in providerName
          ? model
            ? targetLabel(providers, { provider: kind, model })
            : providerName[kind]
          : key;
      return { key, label, until: entry.until, reason: entry.reason };
    })
    .toSorted((a, b) => Date.parse(a.until) - Date.parse(b.until));
}

export function cooldownRowText(row: CooldownRow, nowMs: number, fmt: ClockFormat = {}): string {
  return `${row.label} — limited until ${clockLabel(row.until, nowMs, fmt)}`;
}

export type FailoverNotice =
  | {
      kind: "failedOver";
      from: ModelTarget;
      to: ModelTarget;
      reason: TurnFailureKind | null;
      resetAt: string | null;
    }
  | { kind: "restored"; to: ModelTarget };

const reasonPhrase: Record<TurnFailureKind, string> = {
  rate_limit: "hit its rate limit",
  quota: "hit its usage limit",
  overloaded: "is overloaded",
  auth: "needs you to sign in",
  other: "stopped with an error",
};

/** "Claude hit its usage limit (resets 3:00 PM)", without a final period. */
function limitClause(
  provider: ProviderKind,
  reason: TurnFailureKind | null,
  resetAt: string | null,
  nowMs: number,
  fmt: ClockFormat,
): string {
  const phrase = reason ? reasonPhrase[reason] : "hit a limit";
  const resets = resetAt ? ` (resets ${clockLabel(resetAt, nowMs, fmt)})` : "";
  return `${providerName[provider]} ${phrase}${resets}`;
}

/** The reason line shown under a failed turn. */
export function failureText(
  provider: ProviderKind,
  failure: TurnFailure,
  nowMs: number,
  fmt: ClockFormat = {},
): string {
  return `${limitClause(provider, failure.kind, failure.resetAt ?? null, nowMs, fmt)}.`;
}

export function noticeText(
  notice: FailoverNotice,
  providers: ProviderStatus[],
  nowMs: number,
  fmt: ClockFormat = {},
): string {
  if (notice.kind === "restored") {
    return `Limit reset. Switched back to ${targetLabel(providers, notice.to)}.`;
  }
  const clause = limitClause(notice.from.provider, notice.reason, notice.resetAt, nowMs, fmt);
  return `${clause}. Switched to ${targetLabel(providers, notice.to)} and retried.`;
}

const turnTarget = (turn: Turn) => targetOf(turn);

/** A turn that re-ran the previous turn's prompt after it failed, on a different target. */
export function isFailoverRetry(prev: Turn | undefined, turn: Turn): boolean {
  return (
    prev !== undefined &&
    prev.status === "failed" &&
    prev.prompt === turn.prompt &&
    !sameTarget(turnTarget(prev), turnTarget(turn))
  );
}

/**
 * The read model keeps no failover event on the timeline, so notices are derived from the
 * turn sequence: a failed turn followed by the same prompt on another target is a switch, and
 * its reason comes from the failed turn's `failure`.
 */
export function failoverNoticeFor(
  before: Turn | undefined,
  prev: Turn | undefined,
  turn: Turn,
): FailoverNotice | null {
  if (prev && isFailoverRetry(prev, turn)) {
    return {
      kind: "failedOver",
      from: turnTarget(prev),
      to: turnTarget(turn),
      reason: prev.failure?.kind ?? null,
      resetAt: prev.failure?.resetAt ?? null,
    };
  }
  if (
    prev &&
    before &&
    isFailoverRetry(before, prev) &&
    prev.prompt !== turn.prompt &&
    sameTarget(turnTarget(before), turnTarget(turn))
  ) {
    return { kind: "restored", to: turnTarget(turn) };
  }
  return null;
}

/** Move one row up or down. Out of range or no-op moves return the same array. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): readonly T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

export function removeItem<T>(list: readonly T[], index: number): readonly T[] {
  return list.filter((_, i) => i !== index);
}

/**
 * Targets a thread can be switched to by hand: the ranking first, in order, then every other
 * model of a usable provider. A provider that lists no models keeps its ranked entries.
 */
export function switchTargets(
  ranking: readonly ModelTarget[],
  providers: ProviderStatus[],
  disabled: ReadonlySet<ProviderKind>,
  current: ModelTarget,
): ModelTarget[] {
  const usable = providers.filter((entry) => isAvailable(entry, disabled));
  const listed = (target: ModelTarget) => {
    const provider = usable.find((entry) => entry.kind === target.provider);
    return (
      provider !== undefined &&
      (provider.models.length === 0 || provider.models.some((m) => m.id === target.model))
    );
  };
  const all = [
    ...ranking,
    ...usable.flatMap((entry) => entry.models.map((m) => ({ provider: entry.kind, model: m.id }))),
  ];
  const result: ModelTarget[] = [];
  for (const target of all) {
    if (sameTarget(target, current) || !listed(target)) continue;
    if (target.provider === "demo" && current.provider !== "demo") continue;
    if (result.some((seen) => sameTarget(seen, target))) continue;
    result.push(target);
  }
  return result;
}
