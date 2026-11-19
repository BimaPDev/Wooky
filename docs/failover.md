# Failover (auto switcher)

When a turn fails because the active provider hit a rate limit, quota, or overload,
AGE can switch the thread to another model and retry the same prompt. The user sees a
timeline notice; the conversation continues via the existing handoff path (provider
change with transcript context).

## Triggers

Device settings `failover.triggers` lists which `TurnFailure` kinds may start a
failover (`rate_limit`, `quota`, `overloaded` by default). Other kinds (`auth`, `other`)
are recorded on the turn but do not trigger automatic switching unless an adapter maps
them later.

`failover.enabled` can turn the feature off. `maxSwitchesPerPrompt` caps how many
fallback attempts one prompt may take (default 3).

## Switch flow

1. The adapter finishes a turn with `ProviderEvent` `done` carrying an optional
   `failure` (`kind`, optional `resetAt` / `retryAfterMs`, short `message`).
2. The server records `turn.finished` with the same optional `failure`.
3. If failover applies, the server computes a cooldown (`provider.cooledDown` on a
   provider- or `provider/model` key), picks the next target (`pickFallback` against
   the user chain or `DEFAULT_MODEL_RANKING`), and dispatches internal command
   `thread.failover` with `retryPrompt` (the prompt that failed).
4. The orchestrator handoffs like `thread.configure`: `thread.failedOver` updates the
   thread model, stores `thread.failover` (original target, reason, switch count), and
   the effect runner starts a new turn with the retry prompt.
5. A timeline `notice` item tells the user which model replaced which.

## Cooldowns

`ReadModel.cooldowns` maps a key (`claude`, `cursor/gpt-6.1-sol`, …) to `until` and
`reason`. A provider-level key blocks every model on that provider. `cooldownUntil`
prefers `resetAt`, then `retryAfterMs`, then defaults (15 minutes for rate limit and
overload, 5 hours for quota).

## Switch back

When `failover.switchBack` is true and the original model is no longer cooling down
(and optional `resetAt` has passed), the server may emit `thread.failoverRestored` to
return the thread to `failover.original`.

## User chain

`failover.chain` is an ordered list of up to 12 `ModelTarget` values. An empty chain
means use `DEFAULT_MODEL_RANKING` in `@wooky/domain`.

## Adapter classification (later stations)

Each provider adapter must map native errors into `TurnFailure` on the terminal `done`
event. Examples: HTTP 429 → `rate_limit` with `retryAfterMs` or `resetAt`; billing cap
→ `quota`; capacity errors → `overloaded`; sign-in → `auth`. Unmapped errors stay
`other` and do not auto-failover unless triggers expand.
