import { z } from "zod";
import { ModelTarget, TurnFailure } from "./failover.ts";
import {
  EffortLevel,
  FLEET_LIMITS,
  HistoryTurn,
  Id,
  InteractionMode,
  ProviderKind,
  QuestionAnswers,
  ReviewSide,
  RuntimeMode,
} from "./model.ts";
import { DeviceId } from "./remote.ts";
import { ProjectSettings } from "./scripts.ts";

/** Fields shared by `thread.spawn` and the `agents.spawn` RPC (no commandId). */
export const ThreadSpawnParams = z.object({
  parentThreadId: Id,
  provider: ProviderKind,
  model: z.string().min(1),
  /** Omitted: the worker inherits the parent's runtime mode. */
  runtimeMode: RuntimeMode.optional(),
  prompt: z.string().min(1),
  title: z.string().optional(),
});
export type ThreadSpawnParams = z.infer<typeof ThreadSpawnParams>;

export const FanoutTarget = z.object({
  provider: ProviderKind,
  model: z.string().min(1),
});
export type FanoutTarget = z.infer<typeof FanoutTarget>;

export const FanoutStartParams = z.object({
  projectId: Id,
  prompt: z.string().min(1),
  targets: z.array(FanoutTarget).min(1).max(FLEET_LIMITS.maxFanoutTargets),
  runtimeMode: RuntimeMode,
  title: z.string().optional(),
});
export type FanoutStartParams = z.infer<typeof FanoutStartParams>;

export const MergeStrategy = z.enum(["merge", "squash"]);
export type MergeStrategy = z.infer<typeof MergeStrategy>;

export const ThreadMergeParams = z.object({
  threadId: Id,
  strategy: MergeStrategy,
  /** Commit message for a squash. A plain merge may omit it. */
  message: z.string().optional(),
});
export type ThreadMergeParams = z.infer<typeof ThreadMergeParams>;

export const ReviewAddNoteParams = z.object({
  threadId: Id,
  path: z.string().min(1),
  line: z.number().int().min(1),
  side: ReviewSide,
  body: z.string().min(1).max(FLEET_LIMITS.maxReviewBody),
});
export type ReviewAddNoteParams = z.infer<typeof ReviewAddNoteParams>;

/**
 * Commands are intents sent by clients. Every command carries a client-generated
 * commandId; the server stores a receipt so a retried command never runs twice.
 */
const base = { commandId: Id };

export const Command = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("project.add"),
    root: z.string().min(1),
    name: z.string().optional(),
    /** Marks the hidden "No project" folder. Only the server's scratch service sets it. */
    scratch: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("project.remove"), projectId: Id }),
  z.object({
    ...base,
    type: z.literal("project.configure"),
    projectId: Id,
    settings: ProjectSettings,
  }),
  z.object({
    ...base,
    type: z.literal("thread.create"),
    projectId: Id,
    provider: ProviderKind,
    model: z.string(),
    runtimeMode: RuntimeMode,
    /** Give the thread its own git worktree so parallel threads never share a checkout. */
    isolate: z.boolean(),
    title: z.string().optional(),
    effort: EffortLevel.optional(),
    fastMode: z.boolean().optional(),
    ultracode: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("thread.rename"), threadId: Id, title: z.string().min(1) }),
  z.object({ ...base, type: z.literal("thread.remove"), threadId: Id }),
  z.object({
    ...base,
    type: z.literal("thread.configure"),
    threadId: Id,
    /** Switching provider mid-thread hands the conversation off; native session resets. */
    provider: ProviderKind.optional(),
    model: z.string().optional(),
    runtimeMode: RuntimeMode.optional(),
    interactionMode: InteractionMode.optional(),
    effort: EffortLevel.optional(),
    fastMode: z.boolean().optional(),
    ultracode: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("turn.start"),
    threadId: Id,
    prompt: z.string().min(1),
    /** What to do when a turn is already running. Absent means "reject". */
    whenBusy: z.enum(["reject", "queue"]).optional(),
  }),
  z.object({ ...base, type: z.literal("turn.interrupt"), threadId: Id }),
  z.object({
    ...base,
    type: z.literal("approval.respond"),
    threadId: Id,
    requestId: Id,
    decision: z.enum(["allow", "deny"]),
  }),
  z.object({
    ...base,
    type: z.literal("question.respond"),
    threadId: Id,
    requestId: Id,
    /** null dismisses the question. */
    answers: QuestionAnswers.nullable(),
  }),
  z.object({ ...base, type: z.literal("queue.remove"), threadId: Id, queueId: Id }),
  /**
   * Start this queued prompt now, wherever it sits in the queue. Decided as
   * `queue.removed {reason: "started"}` followed by `turn.started {fromQueueId}`.
   */
  z.object({ ...base, type: z.literal("queue.promote"), threadId: Id, queueId: Id }),
  z.object({
    ...base,
    type: z.literal("turn.revert"),
    threadId: Id,
    /** Restore the workspace to the checkpoint captured before this turn. */
    turnId: Id,
    /** Absent means true. False rewinds the conversation only and leaves files as they are. */
    restoreFiles: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("thread.failover"),
    threadId: Id,
    to: ModelTarget,
    failure: TurnFailure,
    retryPrompt: z.string().min(1),
    /** Target that failed; defaults to the thread's active model when absent. */
    from: ModelTarget.optional(),
    /** Latest turn id that failed; required for race-safe failover dispatch. */
    failedTurnId: Id.optional(),
  }),
  /**
   * Spawn an isolated worker under a solo or coordinator thread and start its first turn.
   * The parent becomes a coordinator. A worker cannot spawn. At most FLEET_LIMITS.maxLiveWorkers
   * children may be working, waiting, or idle.
   */
  z.object({ ...base, type: z.literal("thread.spawn"), ...ThreadSpawnParams.shape }),
  /** One prompt, one isolated thread per target, sharing a fan-out group. */
  z.object({ ...base, type: z.literal("fanout.start"), ...FanoutStartParams.shape }),
  z.object({ ...base, type: z.literal("fanout.pick"), groupId: Id, threadId: Id }),
  z.object({ ...base, type: z.literal("thread.merge"), ...ThreadMergeParams.shape }),
  z.object({ ...base, type: z.literal("review.addNote"), ...ReviewAddNoteParams.shape }),
  z.object({ ...base, type: z.literal("review.removeNote"), threadId: Id, noteId: Id }),
  /** Send every note on the thread as one prompt, then clear them. Queued when a turn is running. */
  z.object({
    ...base,
    type: z.literal("review.send"),
    threadId: Id,
    extra: z.string().optional(),
  }),
  /**
   * Give this thread to another device. Rejected while a turn is running unless `force`
   * (the caller interrupts first). Files must already sync; the event only records the move.
   */
  z.object({
    ...base,
    type: z.literal("thread.release"),
    threadId: Id,
    toDeviceId: DeviceId,
    force: z.boolean().optional(),
  }),
  /**
   * Ask the owner to release a thread, then import it here. `commandId` is the claim id.
   * A second claim for the same owner thread is rejected while one is pending.
   */
  z.object({
    ...base,
    type: z.literal("thread.claim"),
    ownerDeviceId: DeviceId,
    ownerThreadId: Id,
    projectId: Id,
    force: z.boolean().optional(),
  }),
  /**
   * Create a local thread from a peer's copy. `transcript` is the provider handoff.
   * `historyTurns` are finished turns, remapped onto the new thread by the reducer.
   */
  z.object({
    ...base,
    type: z.literal("thread.import"),
    sourceDeviceId: DeviceId,
    sourceThreadId: Id,
    projectId: Id,
    title: z.string().min(1),
    provider: ProviderKind,
    model: z.string().min(1),
    transcript: z.string(),
    historyTurns: z.array(HistoryTurn).max(500).optional(),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
