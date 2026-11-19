import type { MergeState } from "@age/contracts";
import { useEffect, useId, useState } from "react";
import { loadMergePreview } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { MergeDialog } from "./MergeDialog.tsx";
import { isBusy, mergeBlock, shortSha } from "./notes.ts";

/** Merge button for a thread's worktree, with the reason it is blocked and the latest merge result. */
export function MergeControl({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const diffVersion = useStore((state) => state.diffVersion);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ key: string; branch: string; conflicts: number } | null>(
    null,
  );
  const blockId = useId();
  const hasWorktree = Boolean(thread?.worktree);
  const key = `${threadId}:${diffVersion}`;

  // sync: git.mergePreview for the worktree, refreshed when a turn finishes
  useEffect(() => {
    if (!hasWorktree) return;
    let cancelled = false;
    loadMergePreview(threadId).then(
      (result) => {
        if (!cancelled)
          setPreview({
            key,
            branch: result.targetBranch,
            conflicts: result.conflicts.length,
          });
      },
      () => {
        if (!cancelled) setPreview(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadId, hasWorktree, key]);

  const current = preview && preview.key === key ? preview : null;
  const block = mergeBlock({
    hasWorktree,
    busy: isBusy(thread?.status ?? "idle"),
    merging: thread?.merge?.status === "merging",
    conflicts: current?.conflicts ?? 0,
  });

  return (
    <div className="merge-control">
      <div className="merge-control-row">
        <button
          type="button"
          className="button"
          disabled={block !== null}
          aria-describedby={block !== null ? blockId : undefined}
          onClick={() => setOpen(true)}
        >
          {current ? `Merge into ${current.branch}` : "Merge into branch"}
        </button>
        <MergeStatus merge={thread?.merge} />
      </div>
      {block !== null ? (
        <p className="merge-block" id={blockId}>
          {block}
        </p>
      ) : null}
      {open ? <MergeDialog threadId={threadId} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

/** The latest Thread.merge attempt, in one line. Conflict and failure text comes from the server. */
function MergeStatus({ merge }: { merge: MergeState | undefined }) {
  if (!merge) return null;
  const target = merge.targetBranch ?? "the project branch";
  if (merge.status === "merging") {
    return (
      <p className="merge-status" role="status">
        <span className="working" aria-hidden="true" />
        Merging into {target}
      </p>
    );
  }
  if (merge.status === "merged") {
    return (
      <p className="merge-status" role="status">
        Merged into {target} as <span className="mono">{shortSha(merge.commit ?? "")}</span>
      </p>
    );
  }
  if (merge.status === "conflict") {
    return (
      <p className="merge-status error" role="alert">
        Conflict. {merge.message ?? "Resolve the conflicting files, then merge again."}
      </p>
    );
  }
  if (merge.status === "failed") {
    return (
      <p className="merge-status error" role="alert">
        Merge failed. {merge.message ?? "Git did not say why."}
      </p>
    );
  }
  return null;
}
