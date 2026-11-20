import type { FileDiff, Snapshot } from "@wooky/contracts";
import { useEffect, useState } from "react";
import { openChanges, selectThread } from "../../../state/actions.ts";
import { closeHistory, deviceNames, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";
import { Counts, FileDiffView } from "../../DiffView.tsx";
import { IconClose } from "../../Icons.tsx";
import { Modal } from "../../Modal.tsx";
import { Tooltip } from "../../Tooltip.tsx";
import { ConflictCard } from "../conflicts/ConflictCard.tsx";
import {
  deviceName,
  mergePages,
  PAGE_SIZE,
  reasonText,
  summaryText,
  togglePath,
  whenText,
  type DeviceNames,
} from "./helpers.ts";
import { restoreFiles } from "./restore.ts";
import { createSnapshot, diffSnapshot, listSnapshots } from "./rpc.ts";
import { turnForSnapshot } from "./turns.ts";

export function HistoryPanel() {
  const projectId = useAnywhereHistory((state) => state.historyProjectId);
  return projectId ? <HistoryDialog key={projectId} projectId={projectId} /> : null;
}

type Head =
  { key: string; rows: Snapshot[]; error: null } | { key: string; rows: null; error: string };
type DiffLoad =
  { key: string; files: FileDiff[]; error: null } | { key: string; files: null; error: string };

const NO_PATHS: readonly string[] = [];
const NO_TURNS: readonly { id: string; endedAt: string | null }[] = [];

function HistoryDialog({ projectId }: { projectId: string }) {
  const project = useStore((state) => state.model.projects[projectId]);
  const tick = useAnywhereHistory((state) => state.snapshotTick);
  const status = useAnywhereHistory((state) => state.syncStatus);
  const localDeviceId = useAnywhereHistory((state) => state.localDevice?.deviceId ?? null);
  const conflicts = (status?.conflicts ?? []).filter(
    (conflict) => conflict.projectId === projectId,
  );
  const devices: DeviceNames = { localDeviceId, names: deviceNames(status) };

  const [head, setHead] = useState<Head | null>(null);
  const [tail, setTail] = useState<{ rows: Snapshot[]; done: boolean; busy: boolean }>({
    rows: [],
    done: false,
    busy: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareWorking, setCompareWorking] = useState(false);
  const [diff, setDiff] = useState<DiffLoad | null>(null);
  const [checked, setChecked] = useState<{ snapshotId: string; paths: string[] }>({
    snapshotId: "",
    paths: [],
  });
  const [confirming, setConfirming] = useState<{ paths: string[] | null } | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const rows = mergePages(head?.rows ?? [], tail.rows);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const selectedRowId = selected?.id ?? null;
  const selectedKey = selectedRowId
    ? `${selectedRowId}:${compareWorking ? "working" : "parent"}`
    : null;

  // sync: server sync.snapshots.list, first page again whenever a snapshot push arrives
  useEffect(() => {
    let cancelled = false;
    const key = `${projectId}:${tick}`;
    listSnapshots({ projectId, kind: "files", limit: PAGE_SIZE }).then(
      (page) => !cancelled && setHead({ key, rows: page, error: null }),
      (failure: unknown) =>
        !cancelled &&
        setHead({
          key,
          rows: null,
          error: failure instanceof Error ? failure.message : "Could not load the history.",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, tick]);

  // sync: server sync.snapshots.diff for the selected snapshot, or against the working files
  useEffect(() => {
    if (!selectedRowId) return;
    let cancelled = false;
    const key = `${selectedRowId}:${compareWorking ? "working" : "parent"}`;
    diffSnapshot(selectedRowId, compareWorking ? "working" : undefined).then(
      (files) => !cancelled && setDiff({ key, files, error: null }),
      (failure: unknown) =>
        !cancelled &&
        setDiff({
          key,
          files: null,
          error: failure instanceof Error ? failure.message : "Could not load the changes.",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [selectedRowId, compareWorking]);

  const loaded: DiffLoad | null = diff && diff.key === selectedKey ? diff : null;
  const files = loaded?.files ?? null;
  const checkedPaths = selected && checked.snapshotId === selected.id ? checked.paths : NO_PATHS;
  const noMore =
    tail.done ||
    (head?.rows !== null && (head?.rows.length ?? 0) < PAGE_SIZE && tail.rows.length === 0);

  const loadOlder = async () => {
    const last = rows.at(-1);
    if (!last || tail.busy) return;
    setTail((state) => ({ ...state, busy: true }));
    try {
      const page = await listSnapshots({
        projectId,
        kind: "files",
        limit: PAGE_SIZE,
        before: last.id,
      });
      setTail((state) => ({
        rows: mergePages(state.rows, page),
        done: page.length < PAGE_SIZE,
        busy: false,
      }));
    } catch {
      setTail((state) => ({ ...state, busy: false }));
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await createSnapshot(projectId, label.trim());
      setLabel("");
      setSelectedId(created.id);
      setHead((state) =>
        state && state.rows ? { ...state, rows: [created, ...state.rows] } : state,
      );
      useAnywhereHistory.setState((state) => ({ snapshotTick: state.snapshotTick + 1 }));
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : "Could not save a snapshot.");
    }
    setSaving(false);
  };

  return (
    <Modal label="Project history" onClose={closeHistory} className="modal history-modal">
      <header className="history-head">
        <h2 className="history-title">
          <span className="muted">Project history</span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          {project?.name ?? "Project"}
        </h2>
        <Tooltip label="Close" shortcut="Esc">
          <button
            type="button"
            className="icon-button"
            aria-label="Close project history"
            onClick={closeHistory}
          >
            <IconClose />
          </button>
        </Tooltip>
      </header>
      <div className="history-body">
        <div className="history-timeline">
          <form
            className="history-save"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <input
              value={label}
              placeholder="Label, optional"
              aria-label="Snapshot label"
              onChange={(event) => setLabel(event.target.value)}
            />
            <button type="submit" className="button" disabled={saving}>
              Save snapshot now
            </button>
          </form>
          {saveError ? (
            <p className="history-error" role="alert">
              {saveError}
            </p>
          ) : null}
          {!head ? <p className="empty-state small">Loading history.</p> : null}
          {head?.error ? <p className="empty-state small error">{head.error}</p> : null}
          {head?.rows && rows.length === 0 ? (
            <p className="empty-state small">No snapshots yet.</p>
          ) : null}
          <ol className="history-list" aria-label="Snapshots, newest first">
            {rows.map((row) => (
              <HistoryRow
                key={row.id}
                snapshot={row}
                devices={devices}
                active={row.id === selected?.id}
                onSelect={() => {
                  setSelectedId(row.id);
                  setCompareWorking(false);
                }}
              />
            ))}
          </ol>
          {rows.length > 0 && !noMore ? (
            <button
              type="button"
              className="ghost-button history-more"
              disabled={tail.busy}
              onClick={() => void loadOlder()}
            >
              Load older
            </button>
          ) : null}
        </div>
        <section className="history-detail" aria-label="Snapshot changes">
          {conflicts.map((conflict) => (
            <ConflictCard key={conflict.id} conflict={conflict} />
          ))}
          {selected ? (
            <>
              <div className="history-detail-head">
                <div className="history-detail-title">
                  <strong>{reasonText(selected, devices)}</strong>
                  <span className="muted">
                    {new Date(selected.createdAt).toLocaleString()} ·{" "}
                    {deviceName(devices, selected.deviceId)}
                  </span>
                </div>
                <label className="history-compare">
                  <input
                    type="checkbox"
                    checked={compareWorking}
                    onChange={(event) => setCompareWorking(event.target.checked)}
                  />
                  Compare with current files
                </label>
              </div>
              {!loaded ? <p className="empty-state small">Loading changes.</p> : null}
              {loaded?.error ? <p className="empty-state small error">{loaded.error}</p> : null}
              {files && files.length === 0 ? (
                <p className="empty-state small">
                  {compareWorking
                    ? "The current files match this snapshot."
                    : "This snapshot changed no files."}
                </p>
              ) : null}
              {files && files.length > 0 ? (
                <>
                  <FileChecklist
                    files={files}
                    checked={checkedPaths}
                    onChange={(paths) => setChecked({ snapshotId: selected.id, paths })}
                  />
                  <div className="history-restore">
                    <button
                      type="button"
                      className="button"
                      disabled={checkedPaths.length === 0}
                      onClick={() => setConfirming({ paths: [...checkedPaths] })}
                    >
                      Restore selected{checkedPaths.length > 0 ? ` (${checkedPaths.length})` : ""}
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => setConfirming({ paths: null })}
                    >
                      Restore all
                    </button>
                  </div>
                  <div className="history-diffs">
                    {files.map((file) => (
                      <FileDiffView
                        key={`${selectedKey}:${file.path}`}
                        file={file}
                        defaultOpen={files.length < 4}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <p className="empty-state small">Select a snapshot to see what changed.</p>
          )}
        </section>
      </div>
      {confirming && selected ? (
        <ConfirmRestore
          snapshot={selected}
          devices={devices}
          paths={confirming.paths}
          fileCount={
            confirming.paths?.length ?? files?.length ?? selected.summary?.filesChanged ?? 0
          }
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </Modal>
  );
}

function HistoryRow({
  snapshot,
  devices,
  active,
  onSelect,
}: {
  snapshot: Snapshot;
  devices: DeviceNames;
  active: boolean;
  onSelect: () => void;
}) {
  const thread = useStore((state) =>
    snapshot.threadId ? state.model.threads[snapshot.threadId] : undefined,
  );
  const allTurns = useStore((state) =>
    snapshot.threadId ? state.model.turns[snapshot.threadId] : undefined,
  );
  const turns = snapshot.reason === "turn" ? (allTurns ?? NO_TURNS) : NO_TURNS;
  const turnIndex = snapshot.reason === "turn" ? turnForSnapshot(turns, snapshot.createdAt) : -1;
  const turn = turnIndex >= 0 ? turns[turnIndex] : undefined;
  return (
    <li className={active ? "history-row active" : "history-row"}>
      <button
        type="button"
        className="history-row-button"
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="history-row-top">
          <span className="history-reason">{reasonText(snapshot, devices)}</span>
          <time className="history-time" dateTime={snapshot.createdAt}>
            {whenText(snapshot.createdAt)}
          </time>
        </span>
        <span className="history-row-meta">
          <span>{deviceName(devices, snapshot.deviceId)}</span>
          <span aria-hidden="true">·</span>
          <span>{summaryText(snapshot.summary)}</span>
          {snapshot.summary ? (
            <Counts
              additions={snapshot.summary.insertions}
              deletions={snapshot.summary.deletions}
            />
          ) : null}
        </span>
      </button>
      {thread && snapshot.threadId ? (
        <button
          type="button"
          className="link-button history-turn-link"
          onClick={() => {
            closeHistory();
            selectThread(snapshot.threadId);
            if (turn) openChanges(turn.id, null);
          }}
        >
          {turn ? `Turn ${turnIndex + 1} in ` : "Thread "}
          {thread.title}
        </button>
      ) : null}
    </li>
  );
}

function FileChecklist({
  files,
  checked,
  onChange,
}: {
  files: readonly FileDiff[];
  checked: readonly string[];
  onChange: (paths: string[]) => void;
}) {
  const all = checked.length === files.length;
  return (
    <fieldset className="history-files">
      <legend className="sr-only">Files to restore</legend>
      <label className="history-file all">
        <input
          type="checkbox"
          checked={all}
          onChange={() => onChange(all ? [] : files.map((file) => file.path))}
        />
        <span>All files ({files.length})</span>
      </label>
      {files.map((file) => (
        <label key={file.path} className="history-file">
          <input
            type="checkbox"
            checked={checked.includes(file.path)}
            onChange={() => onChange(togglePath(checked, file.path))}
          />
          <span className="mono file-path">{file.path}</span>
          <Counts additions={file.additions} deletions={file.deletions} />
        </label>
      ))}
    </fieldset>
  );
}

function ConfirmRestore({
  snapshot,
  devices,
  paths,
  fileCount,
  onClose,
}: {
  snapshot: Snapshot;
  devices: DeviceNames;
  paths: string[] | null;
  fileCount: number;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = paths
    ? `${paths.length} selected ${paths.length === 1 ? "file" : "files"}`
    : fileCount > 0
      ? `all ${fileCount} changed ${fileCount === 1 ? "file" : "files"}`
      : "all files";
  return (
    <Modal label="Restore files" onClose={onClose} className="modal small">
      <form
        method="dialog"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            await restoreFiles(snapshot.id, paths);
            // The toast with Undo sits under an open dialog, so the panel closes with the restore.
            onClose();
            closeHistory();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Could not restore the files.");
            setBusy(false);
          }
        }}
      >
        <h2 className="modal-title">Restore files</h2>
        <p className="modal-body">
          Restore {what} to how they were at {whenText(snapshot.createdAt)} (
          {reasonText(snapshot, devices).toLowerCase()}). Wooky saves a backup of the current files
          first, so you can undo this.
        </p>
        {error ? (
          <p className="modal-body warn" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            Restore
          </button>
        </div>
      </form>
    </Modal>
  );
}
