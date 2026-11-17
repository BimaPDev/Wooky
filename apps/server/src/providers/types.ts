import type {
  ApprovalRequest,
  ProviderEvent,
  ProviderKind,
  ProviderStatus,
  RuntimeMode,
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
  /** Prior conversation as text when the thread was handed off from another provider. */
  handoffContext: string | null;
  signal: AbortSignal;
  /** Resolve an approval card. Only called when runtimeMode requires it. */
  requestApproval: (request: ApprovalRequest) => Promise<"allow" | "deny">;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Cheap availability check. Must not start a model turn or spend quota. */
  probe(): Promise<ProviderStatus>;
  runTurn(input: TurnInput): AsyncIterable<ProviderEvent>;
}
