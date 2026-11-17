import type { FileDiff } from "@age/contracts";
import { useEffect, useState } from "react";
import { closeChanges, loadDiff, openChanges } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Counts, FileDiffView, fileAnchor } from "./DiffView.tsx";
import { IconClose } from "./Icons.tsx";

type Load =
  | { state: "loading" }
  | { state: "ready"; files: FileDiff[] }
  | { state: "error"; message: string };

export function ChangesPanel({ threadId }: { threadId: string }) {
  const turnId = useStore((state) => state.changes.turnId);
  const focusPath = useStore((state) => state.changes.focusPath);
  const version = useStore((state) => state.diffVersion);
  const [load, setLoad] = useState<{ key: string; value: Load } | null>(null);
  const key = `${threadId}:${turnId ?? ""}:${version}`;

  // sync: server git.diff for the thread, refetched when a turn finishes
  useEffect(() => {
    let cancelled = false;
    loadDiff(threadId, turnId).then(
      (files) => !cancelled && setLoad({ key, value: { state: "ready", files } }),
      (error: unknown) =>
        !cancelled &&
        setLoad({
          key,
          value: {
            state: "error",
            message: error instanceof Error ? error.message : "Could not load changes.",
          },
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [threadId, turnId, key]);

  const current: Load = load && load.key === key ? load.value : { state: "loading" };

  // sync: scroll the requested file into view once the diff has rendered
  useEffect(() => {
    if (current.state !== "ready" || !focusPath) return;
    document.getElementById(fileAnchor(focusPath))?.scrollIntoView({ block: "start" });
  }, [current.state, focusPath]);

  const totals =
    current.state === "ready"
      ? current.files.reduce(
          (sum, file) => ({
            additions: sum.additions + file.additions,
            deletions: sum.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        )
      : null;

  return (
    <aside className="panel" aria-label="Changes">
      <header className="panel-head">
        <span className="panel-title">{turnId ? "Changes in this turn" : "Changes"}</span>
        {totals ? <Counts {...totals} /> : null}
        {turnId ? (
          <button type="button" className="link-button" onClick={() => openChanges(null, null)}>
            Whole thread
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button"
          aria-label="Close changes"
          onClick={closeChanges}
        >
          <IconClose />
        </button>
      </header>
      <div className="panel-scroll">
        {current.state === "loading" ? <p className="empty-state small">Loading changes.</p> : null}
        {current.state === "error" ? (
          <p className="empty-state small error">{current.message}</p>
        ) : null}
        {current.state === "ready" && current.files.length === 0 ? (
          <p className="empty-state small">No changes yet.</p>
        ) : null}
        {current.state === "ready" && current.files.length > 0 ? (
          <>
            <ul className="file-list">
              {current.files.map((file) => (
                <li key={file.path}>
                  <a className="file-link" href={`#${fileAnchor(file.path)}`}>
                    <span className="mono file-path">{file.path}</span>
                    <Counts additions={file.additions} deletions={file.deletions} />
                  </a>
                </li>
              ))}
            </ul>
            {current.files.map((file) => (
              <FileDiffView
                key={`${key}:${file.path}`}
                file={file}
                defaultOpen={!focusPath || focusPath === file.path || current.files.length < 6}
              />
            ))}
          </>
        ) : null}
      </div>
    </aside>
  );
}
