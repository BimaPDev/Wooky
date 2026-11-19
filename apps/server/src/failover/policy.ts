import type {
  AgeEventOf,
  DeviceSettings,
  FailoverSettings,
  ModelTarget,
  PendingEvent,
  ProviderStatus,
  ReadModel,
} from "@age/contracts";
import { pickFallback } from "@age/domain";
import type { LimitsService } from "../usage/limits.ts";
import { buildAvailable } from "./availability.ts";
import { cooledDownIfNeeded } from "./cooldown.ts";

export function failoverCommandId(turnId: string): string {
  return `failover:${turnId}`;
}

export async function maybeFailoverAfterTurn(input: {
  model: ReadModel;
  finished: AgeEventOf<"turn.finished">;
  settings: DeviceSettings;
  listProviders: () => Promise<ProviderStatus[]>;
  dispatch: (command: {
    commandId: string;
    type: "thread.failover";
    threadId: string;
    to: ModelTarget;
    failure: NonNullable<AgeEventOf<"turn.finished">["failure"]>;
    retryPrompt: string;
  }) => void;
  recordCooldown: (events: PendingEvent[]) => void;
  limits?: LimitsService;
  now: string;
}): Promise<void> {
  const failure = input.finished.failure;
  if (!failure || input.finished.status !== "failed") return;

  const failover = input.settings.failover;
  if (!shouldAutoFailover(failover, failure.kind)) return;

  const thread = input.model.threads[input.finished.threadId];
  const turn = input.model.turns[input.finished.threadId]?.find(
    (candidate) => candidate.id === input.finished.turnId,
  );
  if (!thread || !turn) return;

  if (
    failure.kind === "rate_limit" &&
    thread.provider === "claude" &&
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

  const statuses = await input.listProviders();
  const available = buildAvailable(statuses, input.settings);
  const fallback = pickFallback({
    readModel: input.model,
    thread,
    chain: failover.chain,
    now: input.now,
    available,
    failure,
    maxSwitchesPerPrompt: failover.maxSwitchesPerPrompt,
  });

  const failedTarget: ModelTarget = { provider: turn.provider, model: turn.model };

  if (fallback) {
    input.dispatch({
      commandId: failoverCommandId(input.finished.turnId),
      type: "thread.failover",
      threadId: thread.id,
      to: fallback,
      failure,
      retryPrompt: turn.prompt,
    });
    return;
  }

  const cooled = cooledDownIfNeeded(input.model, failedTarget, failure, input.now);
  if (cooled) input.recordCooldown([{ ...cooled, commandId: null }]);
}

function shouldAutoFailover(
  settings: FailoverSettings,
  kind: NonNullable<AgeEventOf<"turn.finished">["failure"]>["kind"],
): boolean {
  if (!settings.enabled) return false;
  return settings.triggers.includes(kind as (typeof settings.triggers)[number]);
}
