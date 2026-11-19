import type { FileDiff, FleetStatus, MergePreview, Thread } from "@wooky/contracts";
import { groupThreads } from "@wooky/domain";
import { useEffect, useRef, useState } from "react";
import {
  closeCompare,
  confirm,
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
import {
  BOARD_STATUS_LABEL,
  lastAssistantText,
  promptPreview,
  selectFleetStatusById,
} from "./helpers.ts";
import { ProviderMark } from "../ProviderMark.tsx";

export function CompareView({ groupId }: { groupId: string }) {
  const model = useStore((state) => state.model);
  const group = model.groups[groupId];
  const threads = groupThreads(model, groupId);
  const statusById = selectFleetStatusById(model);
  const [tabbed, setTabbed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches,
  );
  const [tab, setTab] = useState(threads[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

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
  const anyMergeLock = threads.some(
    (thread) => thread.merge?.status === "merging" || thread.merge?.status === "conflict",
  );
  const mergeHappened = threads.some((thread) => thread.merge?.status === "merged");

  const pick = (threadId: string) => {
    const run = () => {
      setBusy(true);
      void pickFanoutWinner(groupId, threadId).finally(() => setBusy(false));
    };
    if (group.winnerThreadId && group.winnerThreadId !== threadId && mergeHappened) {
      confirm({
        title: "Pick a different winner",
        body: "A merge already happened. Pick this thread instead?",
        confirmLabel: "Pick this one instead",
        onConfirm: run,
      });
      return;
    }
    run();
  };

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
              id={`fleet-compare-tab-${thread.id}`}
              role="tab"
              aria-selected={thread.id === activeId}
              aria-controls={`fleet-compare-panel-${thread.id}`}
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
              status={statusById[thread.id] ?? "idle"}
              winnerId={group.winnerThreadId}
              tabbed={tabbed}
              isActive={thread.id === activeId}
              busy={busy}
              anyMergeLock={anyMergeLock}
              onPick={() => pick(thread.id)}
              onMerge={() => {
                setBusy(true);
                void mergeFanoutThread(thread.id).finally(() => setBusy(false));
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CompareColumn({
  thread,
  status,
  winnerId,
  tabbed,
  isActive,
  busy,
  anyMergeLock,
  onPick,
  onMerge,
}: {
  thread: Thread;
  status: FleetStatus;
  winnerId?: string;
  tabbed: boolean;
  isActive: boolean;
  busy: boolean;
  anyMergeLock: boolean;
  onPick: () => void;
  onMerge: () => void;
}) {
  const providers = useStore((state) => state.providers);
  const summary = useStore((state) =>
    lastAssistantText(finalMessage(state.model.turns[thread.id])),
  );
  const picked = winnerId === thread.id;
  const version = useStore((state) => state.diffVersion);
  const previewKey = `${thread.id}:${version}`;
  const diffKey = `${thread.id}:${version}`;
  const [preview, setPreview] = useState<{ key: string; value: MergePreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ key: string; value: FileDiff[] } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [wideVisible, setWideVisible] = useState(() => typeof IntersectionObserver !== "function");
  const [wideExpanded, setWideExpanded] = useState(false);
  const columnRef = useRef<HTMLElement>(null);
  const visible = tabbed ? isActive : wideVisible;
  const expanded = tabbed || wideExpanded;
  const loadPreview = tabbed ? isActive : visible;
  const loadDiffs = tabbed ? isActive : visible && expanded;

  // sync: wide columns load when they enter the viewport
  useEffect(() => {
    if (tabbed) return;
    const node = columnRef.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setWideVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tabbed]);

  // sync: merge-preview file list is the first summary for this column
  useEffect(() => {
    if (!loadPreview) return;
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
  }, [loadPreview, thread.id, previewKey]);

  // sync: full diffs after the column is active, visible, or expanded
  useEffect(() => {
    if (!loadDiffs) return;
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
  }, [loadDiffs, thread.id, diffKey]);

  const loadedPreview = preview?.key === previewKey ? preview.value : null;
  const loadedFiles = files?.key === diffKey ? files.value : null;
  const summaryFiles = loadedPreview?.files ?? [];
  const totals = summaryFiles.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const conflicts = loadedPreview?.conflicts ?? [];
  const mergeBlocked = conflicts.length > 0;
  const merge = thread.merge;
  const threadBusy = thread.status === "running" || thread.status === "waiting";
  const gated = busy || threadBusy || anyMergeLock;
  const pickLabel =
    winnerId && !picked ? "Pick this one instead" : picked ? "Picked" : "Pick this one";

  return (
    <article
      ref={columnRef}
      className={picked ? "fleet-column picked" : "fleet-column"}
      id={`fleet-compare-panel-${thread.id}`}
      role={tabbed ? "tabpanel" : undefined}
      aria-labelledby={tabbed ? `fleet-compare-tab-${thread.id}` : undefined}
      aria-label={thread.title}
    >
      <header className="fleet-column-head">
        <span className="fleet-column-status">
          <FleetStatusMark status={status} />
          <span>{BOARD_STATUS_LABEL[status]}</span>
        </span>
        <button type="button" className="link-button" onClick={() => selectThread(thread.id)}>
          Open thread
        </button>
      </header>
      <p className="fleet-column-identity">
        <ProviderMark kind={thread.provider} />
        <span>
          {providerLabels[thread.provider]} · {modelLabel(providers, thread.provider, thread.model)}
        </span>
      </p>
      <h2 className="fleet-column-title">{thread.title || "Untitled thread"}</h2>
      <p className="fleet-column-summary">{summary}</p>
      <div className="fleet-column-scroll">
        {previewError ? <p className="empty-state small error">{previewError}</p> : null}
        {loadPreview && loadedPreview === null && !previewError ? (
          <p className="empty-state small">Loading file list.</p>
        ) : null}
        {loadedPreview && summaryFiles.length === 0 ? (
          <p className="empty-state small">No file changes.</p>
        ) : null}
        {summaryFiles.length > 0 ? (
          <div className="fleet-column-files">
            <span>
              {summaryFiles.length} {summaryFiles.length === 1 ? "file" : "files"}
            </span>
            <Counts additions={totals.additions} deletions={totals.deletions} />
          </div>
        ) : null}
        {!tabbed && summaryFiles.length > 0 ? (
          <button
            type="button"
            className="link-button fleet-column-expand"
            aria-expanded={expanded}
            onClick={() => setWideExpanded((open) => !open)}
          >
            {expanded ? "Hide diffs" : "Show diffs"}
          </button>
        ) : null}
        {diffError ? <p className="empty-state small error">{diffError}</p> : null}
        {loadDiffs && loadedFiles === null && !diffError ? (
          <p className="empty-state small">Loading changes.</p>
        ) : null}
        {loadedFiles?.map((file) => (
          <FileDiffView key={file.path} file={file} defaultOpen={false} />
        ))}
      </div>
      <footer className="fleet-column-foot">
        <button
          type="button"
          className={picked ? "button primary" : "button"}
          disabled={gated || picked}
          onClick={onPick}
        >
          {pickLabel}
        </button>
        {picked ? (
          <MergePanel
            thread={thread}
            preview={loadedPreview}
            previewError={previewError}
            mergeBlocked={mergeBlocked}
            conflicts={conflicts}
            merge={merge}
            disabled={gated || mergeBlocked || !loadedPreview}
            onMerge={onMerge}
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
  disabled,
  onMerge,
}: {
  thread: Thread;
  preview: MergePreview | null;
  previewError: string | null;
  mergeBlocked: boolean;
  conflicts: string[];
  merge: Thread["merge"];
  disabled: boolean;
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
        disabled={disabled || merge?.status === "merging" || merge?.status === "merged"}
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
