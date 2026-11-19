import { FLEET_LIMITS, type MergePreview, type MergeStrategy } from "@age/contracts";
import { useEffect, useState } from "react";
import { Counts } from "../DiffView.tsx";
import { Modal } from "../Modal.tsx";
import { loadMergePreview, mergeThread } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { isBusy, mergeBlock } from "./notes.ts";

type Load =
  | { state: "loading" }
  | { state: "ready"; preview: MergePreview }
  | { state: "error"; message: string };

/** Preview of the worktree against the project branch, then the merge. Opens fresh every time. */
export function MergeDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [strategy, setStrategy] = useState<MergeStrategy>("squash");
  const [message, setMessage] = useState("");

  // sync: git.mergePreview for the worktree, fetched each time the dialog opens
  useEffect(() => {
    let cancelled = false;
    loadMergePreview(threadId).then(
      (preview) => {
        if (!cancelled) setLoad({ state: "ready", preview });
      },
      (error: unknown) => {
        if (!cancelled)
          setLoad({
            state: "error",
            message: error instanceof Error ? error.message : "Could not compare the worktree.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const preview = load.state === "ready" ? load.preview : null;
  const block = mergeBlock({
    hasWorktree: Boolean(thread?.worktree),
    busy: isBusy(thread?.status ?? "idle"),
    merging: thread?.merge?.status === "merging",
    conflicts: preview?.conflicts.length ?? 0,
  });
  const canMerge = preview !== null && block === null;

  return (
    <Modal label="Merge into branch" onClose={onClose} className="modal">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canMerge) return;
          void mergeThread(threadId, strategy, message.trim());
          onClose();
        }}
      >
        <h2 className="modal-title">
          {preview ? `Merge into ${preview.targetBranch}` : "Merge into branch"}
        </h2>
        {load.state === "loading" ? (
          <p className="modal-body">Comparing with the project branch.</p>
        ) : null}
        {load.state === "error" ? <p className="modal-body review-error">{load.message}</p> : null}
        {preview ? (
          <>
            <p className="modal-body">
              {preview.ahead} ahead, {preview.behind} behind
            </p>
            {preview.files.length > 0 ? (
              <ul className="merge-files">
                {preview.files.map((file) => (
                  <li key={file.path}>
                    <span className="mono file-path">{file.path}</span>
                    <Counts additions={file.additions} deletions={file.deletions} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="modal-body">No file changes to merge.</p>
            )}
            {preview.conflicts.length > 0 ? (
              <p className="modal-body review-error" role="alert">
                Conflicts in <span className="mono">{preview.conflicts.join(", ")}</span>
              </p>
            ) : null}
          </>
        ) : null}
        <fieldset className="merge-strategy">
          <legend>Strategy</legend>
          <label className="merge-choice">
            <input
              type="radio"
              name="merge-strategy"
              value="squash"
              checked={strategy === "squash"}
              onChange={() => setStrategy("squash")}
            />
            Squash into one commit
          </label>
          <label className="merge-choice">
            <input
              type="radio"
              name="merge-strategy"
              value="merge"
              checked={strategy === "merge"}
              onChange={() => setStrategy("merge")}
            />
            Keep the commits with a merge commit
          </label>
        </fieldset>
        <label className="field">
          <span>Commit message</span>
          <textarea
            rows={3}
            maxLength={FLEET_LIMITS.maxReviewBody}
            value={message}
            placeholder={thread?.title || "Commit message"}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        {block !== null ? <p className="modal-body">{block}</p> : null}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!canMerge}>
            Merge
          </button>
        </div>
      </form>
    </Modal>
  );
}
