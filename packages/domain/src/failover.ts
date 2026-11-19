import type { ModelTarget, ReadModel, Thread, TurnFailure } from "@wooky/contracts";

/** Default best-first ranking when the device chain is empty. Model ids match provider adapters. */
/** Best first. Unavailable or unlisted targets are skipped by the caller's `available`. */
export const DEFAULT_MODEL_RANKING: readonly ModelTarget[] = [
  { provider: "claude", model: "opus" },
  { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "cursor", model: "grok-4.7" },
  { provider: "claude", model: "fable" },
  { provider: "cursor", model: "composer-2.5" },
  { provider: "claude", model: "sonnet" },
  { provider: "codex", model: "gpt-6.1-terra" },
  { provider: "cursor", model: "auto" },
  { provider: "codex", model: "gpt-6-astra" },
  { provider: "claude", model: "haiku" },
  { provider: "codex", model: "gpt-6-luna" },
];

const DEFAULT_MAX_SWITCHES = 3;

const ACCOUNT_SCOPED: ReadonlySet<TurnFailure["kind"]> = new Set([
  "rate_limit",
  "quota",
  "overloaded",
]);

export function cooldownUntil(failure: TurnFailure, now: string): string {
  if (failure.resetAt) return failure.resetAt;
  const base = Date.parse(now);
  if (failure.retryAfterMs !== undefined) {
    return new Date(base + failure.retryAfterMs).toISOString();
  }
  const ms =
    failure.kind === "quota"
      ? 5 * 60 * 60 * 1000
      : failure.kind === "rate_limit" || failure.kind === "overloaded"
        ? 15 * 60 * 1000
        : 15 * 60 * 1000;
  return new Date(base + ms).toISOString();
}

function targetKey(target: ModelTarget): string {
  return `${target.provider}/${target.model}`;
}

function onCooldown(readModel: ReadModel, target: ModelTarget, now: string): boolean {
  const cooldowns = readModel.cooldowns ?? {};
  const providerUntil = cooldowns[target.provider]?.until;
  const modelUntil = cooldowns[targetKey(target)]?.until;
  if (providerUntil && providerUntil > now) return true;
  if (modelUntil && modelUntil > now) return true;
  return false;
}

function sameTarget(a: ModelTarget, b: ModelTarget): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function orderCandidates(
  candidates: readonly ModelTarget[],
  current: ModelTarget,
  failure: TurnFailure,
): ModelTarget[] {
  const filtered = candidates.filter((c) => !sameTarget(c, current));
  if (!ACCOUNT_SCOPED.has(failure.kind)) return filtered;
  const other: ModelTarget[] = [];
  const same: ModelTarget[] = [];
  for (const c of filtered) {
    if (c.provider === current.provider) same.push(c);
    else other.push(c);
  }
  return [...other, ...same];
}

export function pickFallback(input: {
  readModel: ReadModel;
  thread: Thread;
  chain: readonly ModelTarget[];
  now: string;
  available: (target: ModelTarget) => boolean;
  failure: TurnFailure;
  maxSwitchesPerPrompt?: number;
}): ModelTarget | null {
  const maxSwitches = input.maxSwitchesPerPrompt ?? DEFAULT_MAX_SWITCHES;
  const switches = input.thread.failover?.switches ?? 0;
  if (switches >= maxSwitches) return null;

  const current: ModelTarget = { provider: input.thread.provider, model: input.thread.model };
  const ranking = input.chain.length > 0 ? input.chain : DEFAULT_MODEL_RANKING;
  const ordered = orderCandidates(ranking, current, input.failure);

  for (const target of ordered) {
    if (sameTarget(target, current)) continue;
    if (ACCOUNT_SCOPED.has(input.failure.kind) && target.provider === current.provider) continue;
    if (target.provider === "demo" && input.thread.provider !== "demo") continue;
    if (!input.available(target)) continue;
    if (onCooldown(input.readModel, target, input.now)) continue;
    return target;
  }
  return null;
}

export function shouldSwitchBack(thread: Thread, readModel: ReadModel, now: string): boolean {
  const failover = thread.failover;
  if (!failover) return false;
  if (failover.resetAt && failover.resetAt > now) return false;
  if (onCooldown(readModel, failover.original, now)) return false;
  return true;
}
