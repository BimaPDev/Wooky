import { z } from "zod";
import { ThreadFailoverState, TurnFailure, TurnOrigin } from "./failover.ts";
import { ProviderKind } from "./kind.ts";

export { ProviderKind };

/**
 * How much the agent may do without asking.
 * - approve: every edit and command produces an approval card.
 * - auto-edits: file edits run, commands still ask.
 * - full: nothing asks.
 */
export const RuntimeMode = z.enum(["approve", "auto-edits", "full"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

/** default: the agent works. plan: the agent proposes a plan and changes nothing. */
export const InteractionMode = z.enum(["default", "plan"]);
export type InteractionMode = z.infer<typeof InteractionMode>;

/** How hard the agent thinks. Only providers that report `efforts` for a model honour it. */
export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const Id = z.string().min(1).max(128);
export const IsoTime = z.string();

/**
 * Caps the fleet decider enforces. Schemas that can express a cap use these
 * numbers so the wire and the decider cannot drift.
 */
export const FLEET_LIMITS = {
  /** Spawn only from a thread that is not itself a worker. */
  maxDepth: 1,
  /** Workers of one coordinator whose fleet status is working, waiting, or idle. */
  maxLiveWorkers: 8,
  maxFanoutTargets: 6,
  maxReviewBody: 4000,
  maxReportSummary: 8000,
  maxAgentsWaitMs: 600_000,
} as const;

/** Absent on a thread means solo: the thread has not joined a fleet. */
export const ThreadRole = z.enum(["solo", "coordinator", "worker"]);
export type ThreadRole = z.infer<typeof ThreadRole>;

export const MergeStatus = z.enum(["idle", "merging", "merged", "conflict", "failed"]);
export type MergeStatus = z.infer<typeof MergeStatus>;

/** Latest attempt to merge a thread's worktree branch into the project branch. */
export const MergeState = z.object({
  status: MergeStatus,
  targetBranch: z.string().optional(),
  /** Commit created on the project branch when the merge succeeded. */
  commit: z.string().optional(),
  /** Conflict or failure detail, in one sentence. */
  message: z.string().optional(),
  at: IsoTime.optional(),
});
export type MergeState = z.infer<typeof MergeState>;

export const ThreadGroupKind = z.enum(["fanout", "orchestrated"]);
export type ThreadGroupKind = z.infer<typeof ThreadGroupKind>;

/**
 * Threads that share one prompt. Fan-out has no coordinator. An orchestrated
 * group names the coordinator that spawned its workers.
 */
export const ThreadGroup = z.object({
  id: Id,
  projectId: Id,
  kind: ThreadGroupKind,
  prompt: z.string(),
  coordinatorThreadId: Id.optional(),
  threadIds: z.array(Id),
  winnerThreadId: Id.optional(),
  createdAt: IsoTime,
});
export type ThreadGroup = z.infer<typeof ThreadGroup>;

export const ReviewSide = z.enum(["old", "new"]);
export type ReviewSide = z.infer<typeof ReviewSide>;

/** A comment pinned to one diff line. `review.send` turns the thread's notes into one prompt. */
export const ReviewNote = z.object({
  id: Id,
  threadId: Id,
  path: z.string().min(1),
  line: z.number().int().min(1),
  side: ReviewSide,
  body: z.string().min(1).max(FLEET_LIMITS.maxReviewBody),
  createdAt: IsoTime,
});
export type ReviewNote = z.infer<typeof ReviewNote>;

export const DiffStat = z.object({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

/** Latest report a worker sent its coordinator. Replaced when the next turn finishes. */
export const WorkerReport = z.object({
  turnId: Id,
  summary: z.string().max(FLEET_LIMITS.maxReportSummary),
  diffStat: DiffStat.optional(),
  at: IsoTime,
});
export type WorkerReport = z.infer<typeof WorkerReport>;

/** Board status. Distinct from ThreadStatus: a finished worker is `done`, not `idle`. */
export const FleetStatus = z.enum(["working", "waiting", "idle", "done", "failed"]);
export type FleetStatus = z.infer<typeof FleetStatus>;

export const FleetWaitingOn = z.enum(["approval", "question"]);
export type FleetWaitingOn = z.infer<typeof FleetWaitingOn>;

/** One row of the fleet board. Computed from the read model; `fleet.overview` returns the same shape. */
export const FleetRow = z.object({
  threadId: Id,
  projectId: Id,
  title: z.string(),
  provider: ProviderKind,
  model: z.string(),
  /** Always set. A thread that omitted `role` is reported as solo. */
  role: ThreadRole,
  groupId: Id.optional(),
  parentThreadId: Id.optional(),
  status: FleetStatus,
  waitingOn: FleetWaitingOn.optional(),
  lastActivityAt: IsoTime,
  diffStat: DiffStat.optional(),
});
export type FleetRow = z.infer<typeof FleetRow>;

export const Project = z.object({
  id: Id,
  name: z.string(),
  root: z.string(),
  createdAt: IsoTime,
  /** The hidden folder behind "No project". The UI shows it as "No project" and lists no row for it. */
  scratch: z.boolean().optional(),
});
export type Project = z.infer<typeof Project>;

export const Worktree = z.object({
  path: z.string(),
  branch: z.string(),
});
export type Worktree = z.infer<typeof Worktree>;

/** A follow-up typed while a turn runs; it starts when the thread is free. */
export const QueuedPrompt = z.object({
  id: Id,
  prompt: z.string().min(1),
  queuedAt: IsoTime,
});
export type QueuedPrompt = z.infer<typeof QueuedPrompt>;

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
  /** Absent means "default". */
  interactionMode: InteractionMode.optional(),
  /** Absent means the model's own default. */
  effort: EffortLevel.optional(),
  /** Claude fast mode. Absent means off. */
  fastMode: z.boolean().optional(),
  /** Claude ultracode: standing workflow orchestration. Absent means off. */
  ultracode: z.boolean().optional(),
  /** Follow-ups waiting for the running turn, oldest first. */
  queue: z.array(QueuedPrompt).default([]),
  /** Absent on logs written before fleet. Treat as solo. */
  role: ThreadRole.optional(),
  /** Coordinator that spawned this worker. Workers do not spawn further workers. */
  parentThreadId: Id.optional(),
  /** Fan-out or orchestrated group this thread belongs to. */
  groupId: Id.optional(),
  /** Absent until the first merge attempt. */
  merge: MergeState.optional(),
  /** Present after a spawned worker's turn finishes and is reported. */
  report: WorkerReport.optional(),
  /** Set when worktree creation fails for an isolated thread. */
  errorMessage: z.string().optional(),
  status: ThreadStatus,
  createdAt: IsoTime,
  updatedAt: IsoTime,
  failover: ThreadFailoverState.optional(),
});
export type Thread = z.infer<typeof Thread>;

export const ToolKind = z.enum(["read", "edit", "command", "search", "web", "task", "other"]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ItemStatus = z.enum(["running", "done", "failed"]);

/** A multiple-choice question the agent asks the user. */
export const UserQuestion = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean(),
  /** The user may type an answer of their own. */
  allowCustom: z.boolean(),
});
export type UserQuestion = z.infer<typeof UserQuestion>;

/** Chosen labels (or free text) per question id. */
export const QuestionAnswers = z.record(z.string(), z.array(z.string()));
export type QuestionAnswers = z.infer<typeof QuestionAnswers>;

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
    kind: z.literal("question"),
    id: Id,
    requestId: Id,
    questions: z.array(UserQuestion),
    /** null while open, and when dismissed. */
    answers: QuestionAnswers.nullable(),
    dismissed: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    id: Id,
    markdown: z.string(),
    status: z.enum(["proposed", "accepted", "superseded"]),
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
  /** Classified failure (rate limit, quota, ...) when the provider reported one. */
  failure: TurnFailure.optional(),
  /** Set when this turn is a failover retry or an automatic restore. */
  origin: TurnOrigin.optional(),
  /** Provider id of the turn's last native message; where a rewound session resumes. */
  nativeRef: z.string().nullable().optional(),
  interactionMode: InteractionMode.optional(),
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

/** What an adapter supports. A missing flag means unsupported. */
export const ProviderCapabilities = z
  .object({
    rewind: z.boolean(),
    questions: z.boolean(),
    planMode: z.boolean(),
    queue: z.boolean(),
  })
  .partial();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

/** Where a model id came from. Absent on probes written before this field existed. */
export const ModelsSource = z.enum(["live", "static", "custom"]);
export type ModelsSource = z.infer<typeof ModelsSource>;

export const ProviderStatus = z.object({
  kind: ProviderKind,
  label: z.string(),
  installed: z.boolean(),
  /** null = unknown (CLI cannot say without spending a turn). */
  authenticated: z.boolean().nullable(),
  version: z.string().nullable(),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      /** Overrides the provider-level `modelsSource` for this id. */
      modelsSource: ModelsSource.optional(),
      /** Canonical id an alias such as "default" or "opus" resolves to, when the provider says. */
      resolvedModel: z.string().optional(),
      /** Effort levels this model accepts. Absent: the model has no effort setting. */
      efforts: z.array(EffortLevel).optional(),
      /** True when the model has a fast mode. */
      fastMode: z.boolean().optional(),
      /** True when the model can run with ultracode. */
      ultracode: z.boolean().optional(),
    }),
  ),
  /**
   * live: the CLI reported it. static: built into AGE. custom: the user added it.
   * Applies to models that omit their own source.
   */
  modelsSource: ModelsSource.optional(),
  /** Why the provider is unavailable, in one plain sentence. */
  problem: z.string().nullable(),
  capabilities: ProviderCapabilities.optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;
