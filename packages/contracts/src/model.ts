import { z } from "zod";

/** Runtimes AGE can drive. AGE never ships its own model or account. */
export const ProviderKind = z.enum(["claude", "cursor", "codex", "demo"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * How much the agent may do without asking.
 * - approve: every edit and command produces an approval card.
 * - auto-edits: file edits run, commands still ask.
 * - full: nothing asks.
 */
export const RuntimeMode = z.enum(["approve", "auto-edits", "full"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export const Id = z.string().min(1).max(128);
export const IsoTime = z.string();

export const Project = z.object({
  id: Id,
  name: z.string(),
  root: z.string(),
  createdAt: IsoTime,
});
export type Project = z.infer<typeof Project>;

export const Worktree = z.object({
  path: z.string(),
  branch: z.string(),
});
export type Worktree = z.infer<typeof Worktree>;

export const ThreadStatus = z.enum(["idle", "running", "waiting", "error"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const Thread = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  provider: ProviderKind,
  model: z.string(),
  runtimeMode: RuntimeMode,
  worktree: Worktree.nullable(),
  /** True when the thread must run in its own worktree, never in the project root. */
  isolate: z.boolean().optional(),
  /** Native session id reported by the provider, used to resume. Reset on provider switch. */
  providerSessionId: z.string().nullable(),
  status: ThreadStatus,
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Thread = z.infer<typeof Thread>;

export const ToolKind = z.enum(["read", "edit", "command", "search", "web", "task", "other"]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ItemStatus = z.enum(["running", "done", "failed"]);

/** One normalized step of an agent turn. Every provider's output maps onto these. */
export const TimelineItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: Id,
    role: z.enum(["user", "assistant"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("reasoning"),
    id: Id,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("tool"),
    id: Id,
    tool: ToolKind,
    /** Short human title, e.g. "Read src/app.ts" or "pnpm test". */
    title: z.string(),
    /** Raw provider tool name, kept for debugging and marks. */
    name: z.string(),
    status: ItemStatus,
    /** Truncated output preview. Full output is never sent over the wire. */
    output: z.string().optional(),
    files: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("approval"),
    id: Id,
    requestId: Id,
    tool: ToolKind,
    title: z.string(),
    detail: z.string(),
    /** Unified diff preview for edit approvals. */
    diff: z.string().optional(),
    decision: z.enum(["allow", "deny"]).nullable(),
  }),
  z.object({
    kind: z.literal("error"),
    id: Id,
    message: z.string(),
  }),
  z.object({
    kind: z.literal("notice"),
    id: Id,
    text: z.string(),
  }),
]);
export type TimelineItem = z.infer<typeof TimelineItem>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const TurnStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const Turn = z.object({
  id: Id,
  threadId: Id,
  prompt: z.string(),
  provider: ProviderKind,
  model: z.string(),
  status: TurnStatus,
  items: z.array(TimelineItem),
  startedAt: IsoTime,
  endedAt: IsoTime.nullable(),
  /** Hidden git refs captured around the turn (refs/age/checkpoints/...). */
  checkpointBefore: z.string().nullable(),
  checkpointAfter: z.string().nullable(),
  changedFiles: z.array(z.string()),
  usage: Usage.nullable(),
  error: z.string().nullable(),
});
export type Turn = z.infer<typeof Turn>;

export const FileDiff = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  oldPath: z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Unified patch text for this file; omitted for binaries. */
  patch: z.string().optional(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const ProviderStatus = z.object({
  kind: ProviderKind,
  label: z.string(),
  installed: z.boolean(),
  /** null = unknown (CLI cannot say without spending a turn). */
  authenticated: z.boolean().nullable(),
  version: z.string().nullable(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  /** Why the provider is unavailable, in one plain sentence. */
  problem: z.string().nullable(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;
