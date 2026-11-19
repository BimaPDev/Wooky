import type {
  AgeEventOf,
  DeviceSettings,
  FailoverSettings,
  ModelTarget,
  PendingEvent,
  ReadModel,
  Thread,
  TurnFailure,
} from "@age/contracts";
import { pickFallback } from "@age/domain";
import type { LimitsService } from "../usage/limits.ts";
import type { EventStore } from "../store/event-store.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { buildAvailable, probeProvidersFresh } from "./availability.ts";
import { recordCooldownDraft } from "./cooldown.ts";

export function failoverCommandId(turnId: string): string {
  return `failover:${turnId}`;
}

type FailoverDispatch = (command: {
  commandId: string;
  type: "thread.failover";
  threadId: string;
  to: ModelTarget;
  failure: TurnFailure;
  retryPrompt: string;
  from: ModelTarget;
  failedTurnId: string;
}) => void;

export function recordFailedTargetCooldown(input: {
  model: ReadModel;
  target: ModelTarget;
  failure: TurnFailure;
  now: string;
  recordCooldown: (events: PendingEvent[]) => void;
}): void {
  const cooled = recordCooldownDraft(input.model, input.target, input.failure, input.now);
  if (cooled) input.recordCooldown([{ ...cooled, commandId: null }]);
}

export async function maybeFailoverAfterTurn(input: {
  model: ReadModel;
  finished: AgeEventOf<"turn.finished">;
  settings: DeviceSettings;
  providers: ProviderRegistry;
  dispatch: FailoverDispatch;
  recordCooldown: (events: PendingEvent[]) => void;
  limits?: LimitsService;
  now: string;
  readModel: () => ReadModel;
}): Promise<void> {
  const failure = input.finished.failure;
  if (!failure || input.finished.status !== "failed") return;

  const failover = input.settings.failover;
  if (!shouldAutoFailover(failover, failure.kind)) return;

  const turn = input.model.turns[input.finished.threadId]?.find(
    (candidate) => candidate.id === input.finished.turnId,
  );
  const thread = input.model.threads[input.finished.threadId];
  if (!thread || !turn) return;

  const snapshot = {
    threadId: input.finished.threadId,
    turnId: input.finished.turnId,
    failedTarget: { provider: turn.provider, model: turn.model } satisfies ModelTarget,
    failure,
    retryPrompt: turn.prompt,
  };

  if (
    failure.kind === "rate_limit" &&
    turn.provider === "claude" &&
    failure.resetAt &&
    input.limits
  ) {
    const resetMs = Date.parse(failure.resetAt);
    if (Number.isFinite(resetMs)) {
      input.limits.ingestClaudeRateLimit({
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 100,
        resetsAt: Math.floor(resetMs / 1000),
      });
    }
  }

  const statuses = await probeProvidersFresh((kind) => input.providers.get(kind));
  const model = input.readModel();
  const liveThread = model.threads[snapshot.threadId];
  const latest = model.turns[snapshot.threadId]?.at(-1);
  if (!liveStillOnFailedTarget(liveThread, latest, snapshot)) {
    recordFailedTargetCooldown({
      model,
      target: snapshot.failedTarget,
      failure: snapshot.failure,
      now: input.now,
      recordCooldown: input.recordCooldown,
    });
    return;
  }

  if (!liveThread) {
    recordFailedTargetCooldown({
      model,
      target: snapshot.failedTarget,
      failure: snapshot.failure,
      now: input.now,
      recordCooldown: input.recordCooldown,
    });
    return;
  }
  const available = buildAvailable(statuses, input.settings, liveThread);
  const fallback = pickFallback({
    readModel: model,
    thread: liveThread,
    chain: failover.chain,
    now: input.now,
    available,
    failure: snapshot.failure,
    maxSwitchesPerPrompt: failover.maxSwitchesPerPrompt,
  });

  if (!fallback) {
    recordFailedTargetCooldown({
      model,
      target: snapshot.failedTarget,
      failure: snapshot.failure,
      now: input.now,
      recordCooldown: input.recordCooldown,
    });
    return;
  }

  try {
    input.dispatch({
      commandId: failoverCommandId(snapshot.turnId),
      type: "thread.failover",
      threadId: snapshot.threadId,
      to: fallback,
      failure: snapshot.failure,
      retryPrompt: snapshot.retryPrompt,
      from: snapshot.failedTarget,
      failedTurnId: snapshot.turnId,
    });
  } catch {
    recordFailedTargetCooldown({
      model: input.readModel(),
      target: snapshot.failedTarget,
      failure: snapshot.failure,
      now: input.now,
      recordCooldown: input.recordCooldown,
    });
  }
}

export function recoverMissedFailovers(input: {
  store: EventStore;
  settings: DeviceSettings;
  providers: ProviderRegistry;
  dispatch: FailoverDispatch;
  recordCooldown: (events: PendingEvent[]) => void;
  limits?: LimitsService;
  now: string;
}): void {
  const triggers = new Set(input.settings.failover.triggers);
  if (!input.settings.failover.enabled) return;

  for (const threadId of Object.keys(input.store.model.threads)) {
    const thread = input.store.model.threads[threadId];
    if (!thread || thread.status === "running" || thread.status === "waiting") continue;
    const latest = input.store.model.turns[threadId]?.at(-1);
    if (!latest || latest.status !== "failed") continue;
    const finishedEvent = input.store
      .eventsAfter(0)
      .findLast(
        (event): event is AgeEventOf<"turn.finished"> =>
          event.type === "turn.finished" &&
          event.turnId === latest.id &&
          event.threadId === threadId,
      );
    if (!finishedEvent?.failure || !isTriggerFailure(finishedEvent.failure.kind, triggers))
      continue;
    if (thread.provider !== latest.provider || thread.model !== latest.model) continue;
    if (input.store.receipt(failoverCommandId(latest.id))) continue;

    void maybeFailoverAfterTurn({
      model: input.store.model,
      finished: finishedEvent,
      settings: input.settings,
      providers: input.providers,
      dispatch: input.dispatch,
      recordCooldown: input.recordCooldown,
      limits: input.limits,
      now: input.now,
      readModel: () => input.store.model,
    });
  }
}

function liveStillOnFailedTarget(
  thread: Thread | undefined,
  latest: ReadModel["turns"][string][number] | undefined,
  snapshot: { turnId: string; failedTarget: ModelTarget },
): thread is Thread {
  if (!thread || !latest) return false;
  if (latest.id !== snapshot.turnId || latest.status !== "failed") return false;
  if (thread.status === "running" || thread.status === "waiting") return false;
  return (
    thread.provider === snapshot.failedTarget.provider &&
    thread.model === snapshot.failedTarget.model
  );
}

function shouldAutoFailover(settings: FailoverSettings, kind: TurnFailure["kind"]): boolean {
  if (!settings.enabled) return false;
  return isTriggerFailure(kind, new Set(settings.triggers));
}

function isTriggerFailure(
  kind: TurnFailure["kind"],
  triggers: ReadonlySet<FailoverSettings["triggers"][number]>,
): kind is FailoverSettings["triggers"][number] {
  return triggers.has(kind as FailoverSettings["triggers"][number]);
}
