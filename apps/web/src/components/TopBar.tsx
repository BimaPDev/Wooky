import type { Thread } from "@age/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  loadDiff,
  openChanges,
  renameThread,
  toggleChanges,
  toggleSidebar,
  toggleTerminal,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { Counts } from "./DiffView.tsx";
import {
  IconBranch,
  IconChanges,
  IconCopy,
  IconDetails,
  IconFolder,
  IconPanelBottom,
  IconPanelRight,
  IconSidebar,
} from "./Icons.tsx";
import { InlineRename } from "./InlineRename.tsx";
import { modelLabel, providerLabels, runtimeLabel } from "./labels.ts";
import { ProjectMonogram } from "./ProjectMonogram.tsx";

export function TopBar({ desktopChrome = false }: { desktopChrome?: boolean }) {
  const thread = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined,
  );
  const project = useStore((state) =>
    thread ? state.model.projects[thread.projectId] : undefined,
  );
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const changesOpen = useStore((state) => state.changes.open);
  const terminalOpen = useStore((state) => state.terminalOpen);
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Desktop paints project/thread in the native titlebar strip (T3); keep the crumb in browser.
  const showCrumb = !desktopChrome;

  return (
    <header className={desktopChrome ? "topbar topbar-desktop" : "topbar"}>
      {sidebarOpen ? null : (
        <button
          type="button"
          className="icon-button"
          aria-label="Show sidebar"
          title="Show sidebar"
          onClick={toggleSidebar}
        >
          <IconSidebar />
        </button>
      )}
      <div className="topbar-title">
        {showCrumb && thread && project ? (
          <>
            <ProjectMonogram name={project.name} />
            <span className="crumb-project" title={project.root}>
              {project.name}
            </span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            {editing ? (
              <InlineRename
                className="inline-rename title"
                value={thread.title}
                label="Thread title"
                onDone={(title) => {
                  setEditing(false);
                  if (title && title !== thread.title) void renameThread(thread.id, title);
                }}
              />
            ) : (
              <button
                type="button"
                className="title-button"
                title="Rename thread"
                onClick={() => setEditing(true)}
              >
                {thread.title || "Untitled thread"}
              </button>
            )}
          </>
        ) : null}
      </div>
      {thread ? (
        <div className="topbar-actions">
          <div className="popover-anchor">
            <button
              type="button"
              className={detailsOpen ? "icon-button pressed" : "icon-button"}
              aria-label="Thread details"
              aria-expanded={detailsOpen}
              title="Details"
              onClick={() => setDetailsOpen(!detailsOpen)}
            >
              <IconDetails />
            </button>
            {detailsOpen ? (
              <DetailsPopover thread={thread} onClose={() => setDetailsOpen(false)} />
            ) : null}
          </div>
          <button
            type="button"
            className={terminalOpen ? "icon-button pressed" : "icon-button"}
            aria-label="Toggle terminal panel"
            aria-pressed={terminalOpen}
            title="Terminal"
            onClick={toggleTerminal}
          >
            <IconPanelBottom />
          </button>
          <button
            type="button"
            className={changesOpen ? "icon-button pressed" : "icon-button"}
            aria-label="Toggle changes panel"
            aria-pressed={changesOpen}
            title="Changes"
            onClick={toggleChanges}
          >
            <IconPanelRight />
          </button>
        </div>
      ) : null}
    </header>
  );
}

function DetailsPopover({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const project = useStore((state) => state.model.projects[thread.projectId]);
  const providers = useStore((state) => state.providers);
  const version = useStore((state) => state.diffVersion);
  const [totals, setTotals] = useState<{
    key: string;
    additions: number;
    deletions: number;
  } | null>(null);
  const key = `${thread.id}:${version}`;
  const ref = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(() => onClose());

  // sync: server git.diff totals for the details popover
  useEffect(() => {
    let cancelled = false;
    loadDiff(thread.id, null).then(
      (files) =>
        !cancelled &&
        setTotals(
          files.reduce(
            (sum, file) => ({
              key,
              additions: sum.additions + file.additions,
              deletions: sum.deletions + file.deletions,
            }),
            { key, additions: 0, deletions: 0 },
          ),
        ),
      () => !cancelled && setTotals(null),
    );
    return () => {
      cancelled = true;
    };
  }, [thread.id, key]);

  // sync: close on outside pointer or Escape
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="popover details-popover below"
      role="dialog"
      aria-label="Thread details"
    >
      <div className="popover-group">
        <div className="popover-row static" title={project?.root}>
          <IconFolder />
          <span className="popover-label mono">{project?.root ?? "Unknown project"}</span>
          {project ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Copy project path"
              title="Copy path"
              onClick={() => void navigator.clipboard.writeText(project.root)}
            >
              <IconCopy />
            </button>
          ) : null}
        </div>
        <div className="popover-row static">
          <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
          <span className="popover-label">
            {providerLabels[thread.provider]} ·{" "}
            {modelLabel(providers, thread.provider, thread.model)}
          </span>
          <span className="popover-hint">{runtimeLabel(thread.runtimeMode)}</span>
        </div>
      </div>
      <div className="popover-group">
        <div className="popover-row static" title={thread.worktree?.path}>
          <IconBranch />
          <span className="popover-label mono">{thread.worktree?.branch ?? "main"}</span>
          <span className="popover-hint">{thread.worktree ? "Worktree" : "Project root"}</span>
        </div>
        <button
          type="button"
          className="popover-row"
          onClick={() => {
            onClose();
            openChanges(null, null);
          }}
        >
          <IconChanges />
          <span className="popover-label">Changes</span>
          {totals?.key === key ? (
            <Counts additions={totals.additions} deletions={totals.deletions} />
          ) : null}
        </button>
      </div>
    </div>
  );
}
