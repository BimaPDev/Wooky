import { z } from "zod";
import { Id, ProviderKind, RuntimeMode } from "./model.ts";

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
  }),
  z.object({ ...base, type: z.literal("project.remove"), projectId: Id }),
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
  }),
  z.object({ ...base, type: z.literal("turn.start"), threadId: Id, prompt: z.string().min(1) }),
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
    type: z.literal("turn.revert"),
    threadId: Id,
    /** Restore the workspace to the checkpoint captured before this turn. */
    turnId: Id,
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
