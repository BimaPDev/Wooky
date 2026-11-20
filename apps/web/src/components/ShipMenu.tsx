import type { PullRequest, RpcResult } from "@wooky/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import {
  commitGit,
  createPullRequest,
  loadGitStatus,
  loadPrStatus,
  pushGit,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Modal } from "./Modal.tsx";
import { isBusy } from "./review/notes.ts";

type GitStatus = RpcResult<"git.status">;

type Composer = "commit" | "pr" | null;

function assistantBody(threadId: string): string {
  const turns = useStore.getState().model.turns[threadId] ?? [];
  for (let t = turns.length - 1; t >= 0; t--) {
    const items = turns[t]?.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === "message" && item.role === "assistant" && item.text) return item.text;
    }
  }
  return "";
}

export function ShipMenu({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const diffVersion = useStore((state) => state.diffVersion);
  const [status, setStatus] = useState<{ key: string; value: GitStatus | "error" | "loading" }>({
    key: "",
    value: "loading",
  });
  const [composer, setComposer] = useState<Composer>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prDraft, setPrDraft] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const commitHintId = useId();
  const pushHintId = useId();
  const prHintId = useId();
  const key = `${threadId}:${diffVersion}`;
  const pullRequest = thread?.pullRequest ?? null;

  // sync: server git.status and git.pr.status for commit, push and PR affordances
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadGitStatus(threadId), loadPrStatus(threadId)]).then(
      ([gitStatus]) => !cancelled && setStatus({ key, value: gitStatus }),
      () => !cancelled && setStatus({ key, value: "error" }),
    );
    return () => {
      cancelled = true;
    };
  }, [threadId, key]);

  const current = status.key === key ? status.value : "loading";
  const busy = isBusy(thread?.status ?? "idle");

  const gates = useMemo(() => {
    if (busy)
      return { commit: "Agent is working", push: "Agent is working", pr: "Agent is working" };
    if (current === "loading" || current === "error") {
      const loadHint = current === "error" ? "Could not read git status" : "Loading git status";
      return { commit: loadHint, push: loadHint, pr: loadHint };
    }
    const commit = !current.dirty
      ? "No changes to commit"
      : current.branch.length === 0
        ? "Detached HEAD"
        : null;
    const push = !current.hasRemote
      ? "No remote"
      : current.branch.length === 0
        ? "Detached HEAD"
        : current.ahead === 0 && current.upstream
          ? "Nothing to push"
          : null;
    const pr = !current.ghAvailable
      ? "gh not installed"
      : !current.ghAuthed
        ? "Sign in with `gh auth login`"
        : !current.hasRemote
          ? "No remote"
          : current.branch.length === 0
            ? "Detached HEAD"
            : null;
    return { commit, push, pr };
  }, [busy, current]);

  const openCommit = () => {
    setMessage(thread?.title?.trim() ?? "");
    setComposer("commit");
    setNotice(null);
  };

  const openPr = () => {
    setPrTitle(thread?.title?.trim() ?? "");
    setPrBody(assistantBody(threadId));
    setPrBase("");
    setPrDraft(false);
    setComposer("pr");
    setNotice(null);
  };

  const onCommit = async () => {
    const trimmed = message.trim();
    if (trimmed.length === 0) return;
    setBusyAction(true);
    setNotice(null);
    try {
      await commitGit(threadId, trimmed);
      setComposer(null);
      useStore.setState((state) => ({ diffVersion: state.diffVersion + 1 }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not commit.");
    } finally {
      setBusyAction(false);
    }
  };

  const onPush = async () => {
    setBusyAction(true);
    setNotice(null);
    try {
      await pushGit(threadId, current !== "loading" && current !== "error" && !current.upstream);
      useStore.setState((state) => ({ diffVersion: state.diffVersion + 1 }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not push.");
    } finally {
      setBusyAction(false);
    }
  };

  const onCreatePr = async () => {
    const title = prTitle.trim();
    if (title.length === 0) return;
    setBusyAction(true);
    setNotice(null);
    try {
      await createPullRequest({
        threadId,
        title,
        body: prBody,
        base: prBase.trim() || undefined,
        draft: prDraft,
      });
      setComposer(null);
      await loadPrStatus(threadId);
      useStore.setState((state) => ({ diffVersion: state.diffVersion + 1 }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not create a pull request.");
    } finally {
      setBusyAction(false);
    }
  };

  const ahead =
    current !== "loading" && current !== "error" && current.ahead > 0 ? current.ahead : null;

  return (
    <div className="ship-menu">
      <div className="ship-menu-row">
        <button
          type="button"
          className="button"
          disabled={gates.commit !== null || busyAction}
          aria-describedby={gates.commit ? commitHintId : undefined}
          onClick={openCommit}
        >
          Commit
        </button>
        <button
          type="button"
          className="button"
          disabled={gates.push !== null || busyAction}
          aria-describedby={gates.push ? pushHintId : undefined}
          onClick={() => void onPush()}
        >
          {ahead ? `Push (${ahead})` : "Push"}
        </button>
        {pullRequest ? (
          <PrPill pullRequest={pullRequest} />
        ) : (
          <button
            type="button"
            className="button"
            disabled={gates.pr !== null || busyAction}
            aria-describedby={gates.pr ? prHintId : undefined}
            onClick={openPr}
          >
            Create PR
          </button>
        )}
      </div>
      {gates.commit ? (
        <p className="ship-hint" id={commitHintId}>
          {gates.commit}
        </p>
      ) : null}
      {gates.push ? (
        <p className="ship-hint" id={pushHintId}>
          {gates.push}
        </p>
      ) : null}
      {gates.pr ? (
        <p className="ship-hint" id={prHintId}>
          {gates.pr}
        </p>
      ) : null}
      {notice ? <p className="ship-hint error">{notice}</p> : null}
      {composer === "commit" ? (
        <Modal label="Commit" onClose={() => setComposer(null)} className="modal ship-modal">
          <h2 className="modal-title">Commit</h2>
          <label className="field">
            <span className="field-label">Message</span>
            <textarea
              className="field-input"
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busyAction}
              onClick={() => void onCommit()}
            >
              Commit
            </button>
          </div>
        </Modal>
      ) : null}
      {composer === "pr" ? (
        <Modal
          label="Create pull request"
          onClose={() => setComposer(null)}
          className="modal ship-modal"
        >
          <h2 className="modal-title">Create pull request</h2>
          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="field-input"
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Body</span>
            <textarea
              className="field-input"
              rows={6}
              value={prBody}
              onChange={(event) => setPrBody(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Base branch</span>
            <input
              className="field-input"
              value={prBase}
              placeholder="Repo default"
              onChange={(event) => setPrBase(event.target.value)}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={prDraft}
              onChange={(event) => setPrDraft(event.target.checked)}
            />
            <span>Open as draft</span>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busyAction}
              onClick={() => void onCreatePr()}
            >
              Create pull request
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function PrPill({ pullRequest }: { pullRequest: PullRequest }) {
  const label = `#${pullRequest.number} ${pullRequest.state}`;
  return (
    <a className="ship-pr-pill" href={pullRequest.url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}
