import { z } from "zod";
import { Id, TimelineItem, ToolKind, Usage } from "./model.ts";

/**
 * What a provider adapter emits while running one turn. Adapters translate their
 * native protocol (Agent SDK messages, cursor-agent stream-json, codex app-server
 * JSON-RPC, ...) into this small vocabulary and nothing else.
 */
export const ProviderEvent = z.discriminatedUnion("type", [
  /** Native session id, so the next turn can resume. */
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  /** Insert or replace a timeline item (tool started/finished, full message, ...). */
  z.object({ type: z.literal("item"), item: TimelineItem }),
  /** Streamed text for an existing message/reasoning item. */
  z.object({ type: z.literal("delta"), itemId: Id, text: z.string() }),
  z.object({ type: z.literal("usage"), usage: Usage }),
  /** Terminal event. Exactly one per turn, always last. */
  z.object({
    type: z.literal("done"),
    status: z.enum(["completed", "interrupted", "failed"]),
    error: z.string().nullable(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

/** Asked by an adapter when the agent wants to do something gated by the runtime mode. */
export const ApprovalRequest = z.object({
  requestId: Id,
  tool: ToolKind,
  title: z.string(),
  detail: z.string(),
  diff: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;
