import type { QuestionAnswers, Worktree } from "@age/contracts";

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
  | {
      kind: "question.resolve";
      threadId: string;
      turnId: string;
      requestId: string;
      answers: QuestionAnswers | null;
    }
  | { kind: "checkpoint.restore"; threadId: string; turnId: string; cwd: string; ref: string }
  /** Rewind the native session after reverting turnId. keepNativeRef null drops every turn. */
  | { kind: "session.rewind"; threadId: string; turnId: string; keepNativeRef: string | null };

export type StoredEffect = Effect & { id: number };

export function checkpointRef(threadId: string, turnId: string, side: "before" | "after"): string {
  return `refs/age/checkpoints/${threadId}/${turnId}/${side}`;
}

/**
 * Id of the notice the runner adds when a turn's `before` checkpoint was skipped or failed.
 * turn.started stamps checkpointBefore purely, so this item is what marks it as unusable.
 */
export const NO_CHECKPOINT_ITEM = "age-no-checkpoint";
