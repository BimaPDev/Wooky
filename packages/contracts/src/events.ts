import { z } from "zod";
import { ModelTarget, TurnFailure, TurnFailureKind, TurnOrigin } from "./failover.ts";
import {
  DiffStat,
  FLEET_LIMITS,
  Id,
  InteractionMode,
  IsoTime,
  MergeState,
  Project,
  ProviderKind,
  QuestionAnswers,
  QueuedPrompt,
  ReviewNote,
  RuntimeMode,
  Thread,
  ThreadGroup,
  TimelineItem,
  TurnStatus,
  Usage,
  UserQuestion,
  Worktree,
} from "./model.ts";

/**
 * Events are the durable record of decisions. Projections (the read model) are
 * derived only by applying events in `seq` order. Stored events must stay
 * decodable forever: add fields as optional, never repurpose a type.
 */
const meta = {
  /** Monotonic, gap-free sequence assigned by the event store on commit. */
  seq: z.number().int().positive(),
  at: IsoTime,
  /** Command that caused this event, when there is one. */
  commandId: Id.nullable(),
};

export const AgeEvent = z.discriminatedUnion("type", [
  z.object({ ...meta, type: z.literal("project.added"), project: Project }),
  z.object({ ...meta, type: z.literal("project.removed"), projectId: Id }),
  z.object({ ...meta, type: z.literal("thread.created"), thread: Thread }),
  z.object({ ...meta, type: z.literal("thread.renamed"), threadId: Id, title: z.string() }),
  z.object({ ...meta, type: z.literal("thread.removed"), threadId: Id }),
  z.object({
    ...meta,
    type: z.literal("thread.configured"),
    threadId: Id,
    provider: ProviderKind,
    model: z.string(),
    runtimeMode: RuntimeMode,
    /** True when the provider changed and the next turn must hand off context. */
    handoff: z.boolean(),
    interactionMode: InteractionMode.optional(),
  }),
  z.object({
    ...meta,
    type: z.literal("thread.sessionBound"),
    threadId: Id,
    providerSessionId: z.string().nullable(),
  }),
  /** Emitted by the effect runner once an isolated thread's worktree exists. */
  z.object({
    ...meta,
    type: z.literal("thread.worktreeBound"),
    threadId: Id,
    worktree: Worktree,
  }),
  z.object({
    ...meta,
    type: z.literal("turn.started"),
    threadId: Id,
    turnId: Id,
    prompt: z.string(),
    provider: ProviderKind,
    model: z.string(),
    checkpointBefore: z.string().nullable(),
    interactionMode: InteractionMode.optional(),
    /** Set when the turn started from a queued prompt. */
    fromQueueId: Id.optional(),
    /** Set only when the turn is a failover retry or an automatic restore. */
    origin: TurnOrigin.optional(),
  }),
  /** Insert or replace an item by id. */
  z.object({
    ...meta,
    type: z.literal("turn.itemUpserted"),
    threadId: Id,
    turnId: Id,
    item: TimelineItem,
  }),
  /** Append streamed text to a message or reasoning item. Kept small on purpose. */
  z.object({
    ...meta,
    type: z.literal("turn.itemDelta"),
    threadId: Id,
    turnId: Id,
    itemId: Id,
    text: z.string(),
  }),
  z.object({
    ...meta,
    type: z.literal("approval.requested"),
    threadId: Id,
    turnId: Id,
    itemId: Id,
    requestId: Id,
  }),
  z.object({
    ...meta,
    type: z.literal("approval.resolved"),
    threadId: Id,
    turnId: Id,
    requestId: Id,
    decision: z.enum(["allow", "deny"]),
  }),
  /** The item is upserted from `questions` when the turn does not have it yet. */
  z.object({
    ...meta,
    type: z.literal("question.requested"),
    threadId: Id,
    turnId: Id,
    itemId: Id,
    requestId: Id,
    questions: z.array(UserQuestion).min(1),
  }),
  z.object({
    ...meta,
    type: z.literal("question.resolved"),
    threadId: Id,
    turnId: Id,
    requestId: Id,
    /** null means dismissed. */
    answers: QuestionAnswers.nullable(),
  }),
  z.object({
    ...meta,
    type: z.literal("turn.finished"),
    threadId: Id,
    turnId: Id,
    status: TurnStatus.exclude(["running"]),
    checkpointAfter: z.string().nullable(),
    changedFiles: z.array(z.string()),
    usage: Usage.nullable(),
    error: z.string().nullable(),
    nativeRef: z.string().nullable().optional(),
    failure: TurnFailure.optional(),
  }),
  z.object({
    ...meta,
    type: z.literal("turn.reverted"),
    threadId: Id,
    turnId: Id,
    /** Absent means true (older logs always restored files). */
    restoredFiles: z.boolean().optional(),
    /** Replaces the thread's native session when present (rewound or reset to null). */
    providerSessionId: z.string().nullable().optional(),
  }),
  z.object({ ...meta, type: z.literal("queue.added"), threadId: Id, item: QueuedPrompt }),
  z.object({
    ...meta,
    type: z.literal("queue.removed"),
    threadId: Id,
    queueId: Id,
    reason: z.enum(["started", "removed"]),
  }),
  z.object({
    ...meta,
    type: z.literal("provider.cooledDown"),
    key: z.string(),
    until: IsoTime,
    reason: TurnFailureKind,
  }),
  z.object({ ...meta, type: z.literal("provider.cooldownCleared"), key: z.string() }),
  z.object({
    ...meta,
    type: z.literal("thread.failedOver"),
    threadId: Id,
    from: ModelTarget,
    to: ModelTarget,
    failure: TurnFailure,
    switches: z.number().int(),
  }),
  z.object({
    ...meta,
    type: z.literal("thread.failoverRestored"),
    threadId: Id,
    to: ModelTarget,
  }),
  /** A worker thread was created and its parent is now a coordinator. */
  z.object({
    ...meta,
    type: z.literal("thread.spawned"),
    thread: Thread,
    parentThreadId: Id,
  }),
  z.object({ ...meta, type: z.literal("group.created"), group: ThreadGroup }),
  z.object({
    ...meta,
    type: z.literal("group.winnerPicked"),
    groupId: Id,
    threadId: Id,
  }),
  z.object({
    ...meta,
    type: z.literal("thread.mergeChanged"),
    threadId: Id,
    merge: MergeState,
  }),
  z.object({ ...meta, type: z.literal("review.noteAdded"), note: ReviewNote }),
  z.object({
    ...meta,
    type: z.literal("review.noteRemoved"),
    threadId: Id,
    noteId: Id,
  }),
  /** The notes were copied into a prompt. The projection drops these ids. */
  z.object({
    ...meta,
    type: z.literal("review.notesSent"),
    threadId: Id,
    noteIds: z.array(Id),
  }),
  /**
   * A spawned worker's turn finished. The server also queues a follow-up on the
   * coordinator; this event is the durable copy of what that prompt summarizes.
   */
  z.object({
    ...meta,
    type: z.literal("worker.reported"),
    coordinatorThreadId: Id,
    workerThreadId: Id,
    turnId: Id,
    summary: z.string().max(FLEET_LIMITS.maxReportSummary),
    diffStat: DiffStat.optional(),
  }),
  z.object({
    ...meta,
    type: z.literal("thread.worktreeFailed"),
    threadId: Id,
    message: z.string().min(1),
  }),
]);
export type AgeEvent = z.infer<typeof AgeEvent>;
export type AgeEventType = AgeEvent["type"];
export type AgeEventOf<T extends AgeEventType> = Extract<AgeEvent, { type: T }>;

/** An event before the store assigns seq/at. Deciders produce these. */
export type PendingEvent = AgeEvent extends infer E
  ? E extends AgeEvent
    ? Omit<E, "seq" | "at">
    : never
  : never;
