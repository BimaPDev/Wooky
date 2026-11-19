import type {
  ApprovalRequest,
  EffortLevel,
  InteractionMode,
  ProviderEvent,
  ProviderKind,
  ProviderStatus,
  QuestionAnswers,
  RuntimeMode,
  ThreadRole,
  UserInputRequest,
} from "@age/contracts";

/**
 * The adapter boundary. All provider-specific complexity lives behind this
 * interface; orchestration only ever sees ProviderEvent values.
 *
 * Rules for implementers:
 * - Never read credential files. Ask the CLI/SDK whether it is signed in.
 * - Spawn processes only with explicit argv (no shell strings), track the PID you
 *   spawned, and kill only that PID on abort.
 * - Emit exactly one `done` event, last, even on crash or abort.
 * - Keep `tool.output` previews under 4 KB; never stream whole files.
 */
export interface TurnInput {
  threadId: string;
  turnId: string;
  /** Workspace directory (thread worktree or project root). */
  cwd: string;
  prompt: string;
  model: string;
  runtimeMode: RuntimeMode;
  /** Native session to resume, if the thread has one for this provider. */
  resumeSessionId: string | null;
  /**
   * Native message to resume the session at (the last kept turn's nativeRef).
   * null means "continue at the end of the current session", not "start fresh".
   * Only non-null for a provider that cannot rewind natively but can resume at a
   * message (no `rewind`; e.g. Claude's resume + resumeSessionAt + forkSession).
   */
  resumeAt: string | null;
  interactionMode: InteractionMode;
  /** Reasoning effort the user picked. Absent means the model's own default. */
  effort?: EffortLevel;
  /** Claude fast mode, when the user turned it on. */
  fastMode?: boolean;
  /** Claude ultracode, when the user turned it on. */
  ultracode?: boolean;
  /** Prior conversation as text when the thread was handed off from another provider. */
  handoffContext: string | null;
  /** Absent means solo. A worker cannot spawn; every other role may. */
  role?: ThreadRole;
  signal: AbortSignal;
  /** Resolve an approval card. Only called when runtimeMode requires it. */
  requestApproval: (request: ApprovalRequest) => Promise<"allow" | "deny">;
  /** Ask the user structured questions. Resolves to answers per question id, or null if dismissed. */
  requestUserInput: (request: UserInputRequest) => Promise<QuestionAnswers | null>;
}

export interface RewindInput {
  threadId: string;
  /** The thread's current native session. */
  sessionId: string;
  /**
   * Last native message to keep. null means "drop every turn and start fresh", unlike
   * TurnInput.resumeAt, where null means "continue at the end of the session".
   */
  keepNativeRef: string | null;
  /**
   * How many turns the revert dropped (int, at least 1). Computed by decide at revert
   * time: by the time the effect runs, those turns are already gone from the model.
   */
  dropTurns: number;
  cwd: string;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Cheap availability check. Must not start a model turn or spend quota. */
  probe(): Promise<ProviderStatus>;
  runTurn(input: TurnInput): AsyncIterable<ProviderEvent>;
  /**
   * Cut the native conversation back after a revert. Returns the session the next turn
   * resumes, or null to start fresh. The runner binds it (turn.reverted.providerSessionId)
   * and the next turn runs with `resumeAt: null` against it. Adapters without it resume
   * at a message via TurnInput.resumeAt, or, if they cannot, get the handoff transcript.
   */
  rewind?(input: RewindInput): Promise<{ sessionId: string | null }>;
  /** True when the adapter honours TurnInput.resumeAt (resume the native session at a message). */
  supportsResumeAt?: boolean;
}
