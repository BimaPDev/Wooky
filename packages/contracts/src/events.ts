import { z } from "zod";
import {
  Id,
  IsoTime,
  Project,
  ProviderKind,
  RuntimeMode,
  Thread,
  TimelineItem,
  TurnStatus,
  Usage,
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
  }),
  z.object({
    ...meta,
    type: z.literal("thread.sessionBound"),
    threadId: Id,
    providerSessionId: z.string().nullable(),
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
  }),
  z.object({
    ...meta,
    type: z.literal("turn.reverted"),
    threadId: Id,
    turnId: Id,
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
