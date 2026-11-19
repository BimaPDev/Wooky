import type { ModelTarget, ReadModel, TurnFailure, TurnFailureKind } from "@age/contracts";
import { cooldownUntil } from "@age/domain";

const ACCOUNT_SCOPED: ReadonlySet<TurnFailureKind> = new Set(["rate_limit", "quota", "overloaded"]);

const PROVIDER_SCOPED = new Set<ModelTarget["provider"]>(["claude", "cursor", "codex"]);

export function cooldownKey(target: ModelTarget, failure: TurnFailure): string {
  if (ACCOUNT_SCOPED.has(failure.kind) && PROVIDER_SCOPED.has(target.provider)) {
    return target.provider;
  }
  return `${target.provider}/${target.model}`;
}

type CooldownDraft = {
  type: "provider.cooledDown";
  key: string;
  until: string;
  reason: TurnFailureKind;
};

export function cooledDownIfNeeded(
  model: ReadModel,
  target: ModelTarget,
  failure: TurnFailure,
  now: string,
): CooldownDraft | null {
  const key = cooldownKey(target, failure);
  const until = cooldownUntil(failure, now);
  const existing = model.cooldowns?.[key];
  if (existing && existing.until > until) return null;
  return { type: "provider.cooledDown", key, until, reason: failure.kind };
}

type ClearedDraft = { type: "provider.cooldownCleared"; key: string };

export function expiredCooldownClears(model: ReadModel, now: string): ClearedDraft[] {
  const cooldowns = model.cooldowns ?? {};
  return Object.keys(cooldowns)
    .filter((key) => (cooldowns[key]?.until ?? "") <= now)
    .map((key) => ({ type: "provider.cooldownCleared", key }));
}
