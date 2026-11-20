import type { ConflictResolution, FileDiff, SyncConflict } from "@wooky/contracts";
import { useEffect, useState } from "react";
import { deviceLabel, deviceNames, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { DiffLines } from "../../DiffView.tsx";
import { IconChevron } from "../../Icons.tsx";
import { diffSnapshot, resolveConflict } from "../history/rpc.ts";
import { conflictSides, theirsPath } from "./helpers.ts";

type Sides =
  | { state: "loading" }
  | { state: "ready"; mine: FileDiff[]; theirs: FileDiff[] }
  | { state: "error"; message: string };

const choices: {
  resolution: ConflictResolution;
  label: string;
  hint: (conflict: SyncConflict) => string;
}[] = [
  {
    resolution: "mine",
    label: "Keep mine",
    hint: () => "Your files stay as they are.",
  },
  {
    resolution: "theirs",
    label: "Take theirs",
    hint: () => "Their files replace yours. A backup is saved first.",
  },
  {
    resolution: "both",
    label: "Keep both",
    hint: (conflict) =>
      `Yours stay; theirs are saved as ${theirsPath(conflict.paths[0] ?? "name.ext")}.`,
  },
];

export function ConflictCard({ conflict }: { conflict: SyncConflict }) {
  const peer = useAnywhereHistory((state) =>
    deviceLabel(deviceNames(state.syncStatus), conflict.peerDeviceId),
  );
  const [openPath, setOpenPath] = useState<string | null>(conflict.paths[0] ?? null);
  const [sides, setSides] = useState<{ key: string; value: Sides } | null>(null);
  const [busy, setBusy] = useState<ConflictResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = conflict.id;

  // sync: server sync.snapshots.diff for each side of the conflict, loaded once the card shows paths
  useEffect(() => {
    if (conflict.paths.length === 0) return;
    let cancelled = false;
    const { mine, theirs } = conflictSides(conflict);
    Promise.all([
      diffSnapshot(mine.snapshotId, mine.against),
      diffSnapshot(theirs.snapshotId, theirs.against),
    ]).then(
      ([mineFiles, theirFiles]) =>
        !cancelled &&
        setSides({ key, value: { state: "ready", mine: mineFiles, theirs: theirFiles } }),
      (failure: unknown) =>
        !cancelled &&
        setSides({
          key,
          value: {
            state: "error",
            message: failure instanceof Error ? failure.message : "Could not load both sides.",
          },
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [conflict, key]);

  const current: Sides = sides && sides.key === key ? sides.value : { state: "loading" };
  const detail = conflictSides(conflict);

  const resolve = async (resolution: ConflictResolution) => {
    if (busy) return;
    setBusy(resolution);
    setError(null);
    try {
      await resolveConflict(conflict.id, resolution);
      useAnywhereHistory.setState((state) =>
        state.syncStatus
          ? {
              syncStatus: {
                ...state.syncStatus,
                conflicts: state.syncStatus.conflicts.filter((entry) => entry.id !== conflict.id),
              },
            }
          : state,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not resolve the conflict.");
    }
    setBusy(null);
  };

  return (
    <section className="conflict-card" aria-label={`Sync conflict with ${peer}`}>
      <header className="conflict-head">
        <h3 className="conflict-title">Sync conflict with {peer}</h3>
        <p className="conflict-sub">
          {conflict.paths.length === 1
            ? "1 file changed on both devices."
            : `${conflict.paths.length} files changed on both devices.`}{" "}
          Nothing was applied. Choose what to keep.
        </p>
      </header>
      <ul className="conflict-paths">
        {conflict.paths.map((path) => {
          const open = openPath === path;
          return (
            <li key={path} className="conflict-path">
              <button
                type="button"
                className="conflict-path-head"
                aria-expanded={open}
                onClick={() => setOpenPath(open ? null : path)}
              >
                <IconChevron open={open} />
                <span className="mono file-path">{path}</span>
              </button>
              {open ? (
                <div className="conflict-sides">
                  <ConflictSide
                    title="Mine"
                    caption={detail.mine.caption}
                    sides={current}
                    side="mine"
                    path={path}
                  />
                  <ConflictSide
                    title={`Theirs, ${peer}`}
                    caption={detail.theirs.caption}
                    sides={current}
                    side="theirs"
                    path={path}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="conflict-actions">
        {choices.map((choice) => (
          <div key={choice.resolution} className="conflict-choice">
            <button
              type="button"
              className={choice.resolution === "mine" ? "button primary" : "button"}
              disabled={busy !== null}
              aria-busy={busy === choice.resolution}
              onClick={() => void resolve(choice.resolution)}
            >
              {choice.label}
            </button>
            <span className="conflict-hint">{choice.hint(conflict)}</span>
          </div>
        ))}
      </div>
      {error ? (
        <p className="history-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ConflictSide({
  title,
  caption,
  sides,
  side,
  path,
}: {
  title: string;
  caption: string;
  sides: Sides;
  side: "mine" | "theirs";
  path: string;
}) {
  const file = sides.state === "ready" ? sides[side].find((entry) => entry.path === path) : null;
  return (
    <div className="conflict-side">
      <div className="conflict-side-head">
        <span className="conflict-side-title">{title}</span>
        <span className="conflict-side-caption">{caption}</span>
      </div>
      <div className="conflict-side-body">
        {sides.state === "loading" ? <p className="empty-state small">Loading.</p> : null}
        {sides.state === "error" ? (
          <p className="empty-state small error">{sides.message}</p>
        ) : null}
        {sides.state === "ready" && !file ? (
          <p className="diff-empty">No change on this side.</p>
        ) : null}
        {file?.patch ? <DiffLines patch={file.patch} /> : null}
        {file && !file.patch ? <p className="diff-empty">Binary file, no preview.</p> : null}
      </div>
    </div>
  );
}
