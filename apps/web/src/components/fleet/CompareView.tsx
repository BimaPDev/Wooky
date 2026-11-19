import type { FileDiff, FleetStatus, MergePreview, Thread } from "@age/contracts";
import { fleetRows, groupThreads } from "@age/domain";
import { useEffect, useState } from "react";
import {
  closeCompare,
  loadDiff,
  loadMergePreview,
  mergeFanoutThread,
  pickFanoutWinner,
  selectThread,
} from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { Counts, FileDiffView } from "../DiffView.tsx";
import { modelLabel, providerLabels } from "../labels.ts";
import { FleetStatusMark } from "./FleetStatusMark.tsx";
import { BOARD_STATUS_LABEL, lastAssistantText, promptPreview } from "./helpers.ts";

export function CompareView({ groupId }: { groupId: string }) {
  const model = useStore((state) => state.model);
  const group = model.groups[groupId];
  const threads = groupThreads(model, groupId);
  const [tabbed, setTabbed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches,
  );
  const [tab, setTab] = useState(threads[0]?.id ?? "");

  // sync: viewport width switches compare columns to tabs
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 900px)");
    const onChange = () => setTabbed(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  if (!group) {
    return (
      <section className="fleet-compare" aria-label="Compare agents">
        <p className="empty-state">This group is no longer available.</p>
      </section>
    );
  }

  const activeId = threads.some((thread) => thread.id === tab) ? tab : (threads[0]?.id ?? "");
  const visible = tabbed ? threads.filter((thread) => thread.id === activeId) : threads;

  return (
    <section className="fleet-compare" aria-label="Compare agents">
      <header className="fleet-compare-head">
        <div className="fleet-compare-copy">
          <h1 className="fleet-board-title">Compare</h1>
          <p className="fleet-compare-prompt">{promptPreview(group.prompt, 80)}</p>
        </div>
        <button type="button" className="button" onClick={closeCompare}>
          Close
        </button>
      </header>
      {tabbed && threads.length > 1 ? (
        <div className="fleet-compare-tabs" role="tablist" aria-label="Agents">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              role="tab"
              aria-selected={thread.id === activeId}
              className={thread.id === activeId ? "fleet-compare-tab active" : "fleet-compare-tab"}
              onClick={() => setTab(thread.id)}
            >
              {thread.title || thread.model}
            </button>
          ))}
        </div>
      ) : null}
      {threads.length === 0 ? (
        <p className="empty-state">No agents in this group.</p>
      ) : (
        <div
          className={tabbed ? "fleet-compare-grid tabbed" : "fleet-compare-grid"}
          style={
            tabbed
              ? undefined
              : { gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))` }
          }
        >
          {visible.map((thread) => (
            <CompareColumn
              key={thread.id}
              thread={thread}
              groupId={groupId}
              winnerId={group.winnerThreadId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CompareColumn({
  thread,
  groupId,
  winnerId,
}: {
  thread: Thread;
  groupId: string;
  winnerId?: string;
}) {
  const providers = useStore((state) => state.providers);
  const status = useStore(
    (state) => fleetRows(state.model).find((row) => row.threadId === thread.id)?.status ?? "idle",
  );
  const summary = useStore((state) =>
    lastAssistantText(finalMessage(state.model.turns[thread.id])),
  );
  const picked = winnerId === thread.id;
  const version = useStore((state) => state.diffVersion);
  const diffKey = `${thread.id}:${version}`;
  const previewKey = `${thread.id}:${version}:${picked ? "1" : "0"}`;
  const [files, setFiles] = useState<{ key: string; value: FileDiff[] } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; value: MergePreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // sync: server git.diff for this compare column
  useEffect(() => {
    let cancelled = false;
    loadDiff(thread.id, null).then(
      (result) => {
        if (cancelled) return;
        setFiles({ key: diffKey, value: result });
        setDiffError(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        setFiles(null);
        setDiffError(error instanceof Error ? error.message : "Could not load changes.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [thread.id, diffKey]);

  // sync: git.mergePreview after this column is picked
  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    loadMergePreview(thread.id).then(
      (result) => {
        if (cancelled) return;
        setPreview({ key: previewKey, value: result });
        setPreviewError(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(error instanceof Error ? error.message : "Could not preview the merge.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [picked, thread.id, previewKey]);

  const loadedFiles = files?.key === diffKey ? files.value : null;
  const loadedPreview = preview?.key === previewKey ? preview.value : null;
  const totals = loadedFiles
    ? loadedFiles.reduce(
        (sum, file) => ({
          additions: sum.additions + file.additions,
          deletions: sum.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      )
    : null;
  const conflicts = loadedPreview?.conflicts ?? [];
  const mergeBlocked = conflicts.length > 0;
  const merge = thread.merge;

  return (
    <article className={picked ? "fleet-column picked" : "fleet-column"} aria-label={thread.title}>
      <header className="fleet-column-head">
        <span className="fleet-column-status">
          <FleetStatusMark status={status} />
          <span>{statusLabel(status)}</span>
        </span>
        <button type="button" className="link-button" onClick={() => selectThread(thread.id)}>
          Open thread
        </button>
      </header>
      <p className="fleet-column-identity">
        <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
        <span>
          {providerLabels[thread.provider]} · {modelLabel(providers, thread.provider, thread.model)}
        </span>
      </p>
      <h2 className="fleet-column-title">{thread.title || "Untitled thread"}</h2>
      <p className="fleet-column-summary">{summary}</p>
      <div className="fleet-column-scroll">
        {diffError ? <p className="empty-state small error">{diffError}</p> : null}
        {loadedFiles === null && !diffError ? (
          <p className="empty-state small">Loading changes.</p>
        ) : null}
        {loadedFiles && loadedFiles.length === 0 ? (
          <p className="empty-state small">No file changes.</p>
        ) : null}
        {loadedFiles && loadedFiles.length > 0 ? (
          <>
            <div className="fleet-column-files">
              <span>
                {loadedFiles.length} {loadedFiles.length === 1 ? "file" : "files"}
              </span>
              {totals ? <Counts additions={totals.additions} deletions={totals.deletions} /> : null}
            </div>
            {loadedFiles.map((file) => (
              <FileDiffView key={file.path} file={file} defaultOpen={false} />
            ))}
          </>
        ) : null}
      </div>
      <footer className="fleet-column-foot">
        <button
          type="button"
          className={picked ? "button primary" : "button"}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void pickFanoutWinner(groupId, thread.id).finally(() => setBusy(false));
          }}
        >
          {picked ? "Picked" : "Pick this one"}
        </button>
        {picked ? (
          <MergePanel
            thread={thread}
            preview={loadedPreview}
            previewError={previewError}
            mergeBlocked={mergeBlocked}
            conflicts={conflicts}
            merge={merge}
            busy={busy}
            onMerge={() => {
              if (!loadedPreview || mergeBlocked) return;
              setBusy(true);
              void mergeFanoutThread(thread.id, loadedPreview.targetBranch).finally(() =>
                setBusy(false),
              );
            }}
          />
        ) : null}
      </footer>
    </article>
  );
}

function MergePanel({
  thread,
  preview,
  previewError,
  mergeBlocked,
  conflicts,
  merge,
  busy,
  onMerge,
}: {
  thread: Thread;
  preview: MergePreview | null;
  previewError: string | null;
  mergeBlocked: boolean;
  conflicts: string[];
  merge: Thread["merge"];
  busy: boolean;
  onMerge: () => void;
}) {
  const branch = preview?.targetBranch ?? merge?.targetBranch ?? "the project branch";
  return (
    <div className="fleet-merge">
      {previewError ? <p className="empty-state small error">{previewError}</p> : null}
      {preview ? (
        <p className="fleet-merge-preview">
          {preview.ahead} ahead, {preview.behind} behind {preview.targetBranch}
          {preview.files.length > 0
            ? ` · ${preview.files.length} ${preview.files.length === 1 ? "file" : "files"}`
            : ""}
        </p>
      ) : null}
      {mergeBlocked ? (
        <p className="fleet-merge-conflicts">
          Merge is disabled while{" "}
          {conflicts.length === 1 ? "a conflict remains" : "conflicts remain"}:{" "}
          {conflicts.join(", ")}.
        </p>
      ) : null}
      <button
        type="button"
        className="button primary"
        disabled={
          busy ||
          mergeBlocked ||
          !preview ||
          merge?.status === "merging" ||
          merge?.status === "merged"
        }
        onClick={onMerge}
      >
        Merge into {branch}
      </button>
      {merge ? <p className="fleet-merge-status">{mergeStatusText(thread, merge)}</p> : null}
    </div>
  );
}

function finalMessage(
  turns: { items: { kind: string; role?: string; text?: string }[] }[] | undefined,
) {
  const items = turns?.at(-1)?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "message" && item.role === "assistant" && item.text) return item.text;
  }
  return undefined;
}

function statusLabel(status: FleetStatus): string {
  return BOARD_STATUS_LABEL[status];
}

function mergeStatusText(thread: Thread, merge: NonNullable<Thread["merge"]>): string {
  switch (merge.status) {
    case "merging":
      return `Merging into ${merge.targetBranch ?? "the project branch"}.`;
    case "merged":
      return merge.commit
        ? `Merged into ${merge.targetBranch ?? "the project branch"} as ${merge.commit}.`
        : `Merged into ${merge.targetBranch ?? "the project branch"}.`;
    case "conflict":
      return merge.message ?? "Merge stopped on conflicts.";
    case "failed":
      return merge.message ?? "Merge failed.";
    case "idle":
      return `${thread.title || "This thread"} is ready to merge.`;
  }
}
