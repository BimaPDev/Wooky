import type { Worktree } from "@age/contracts";

/** Work the orchestrator asks for. Stored with the events that caused it, run by the effect runner. */
export type Effect =
  | { kind: "worktree.create"; threadId: string; projectRoot: string }
  | { kind: "worktree.remove"; threadId: string; projectRoot: string; worktree: Worktree }
  | { kind: "turn.run"; threadId: string; turnId: string }
  | { kind: "turn.interrupt"; threadId: string; turnId: string }
  | {
      kind: "approval.resolve";
      threadId: string;
      turnId: string;
      requestId: string;
      decision: "allow" | "deny";
    }
  | { kind: "checkpoint.restore"; threadId: string; turnId: string; cwd: string; ref: string };

export type StoredEffect = Effect & { id: number };

export function checkpointRef(threadId: string, turnId: string, side: "before" | "after"): string {
  return `refs/age/checkpoints/${threadId}/${turnId}/${side}`;
}
