import type { Thread } from "@wooky/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  loadDiff,
  navHistoryBack,
  navHistoryForward,
  openChanges,
  renameThread,
  toggleChanges,
  toggleSidebar,
  toggleTerminal,
} from "../state/actions.ts";
import { draftProjectId, isDraftView, useStore } from "../state/store.ts";
import { EnvironmentTag } from "./anywhere/EnvironmentSwitcher.tsx";
import { Counts } from "./DiffView.tsx";
import {
  IconBranch,
  IconChanges,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDetails,
  IconFolder,
  IconPanelBottom,
  IconPanelRight,
  IconSidebar,
  IconSliders,
} from "./Icons.tsx";
import { usePhone, IconMenu } from "./anywhere/phone/phone.tsx";
import { ReplicaCrumb } from "./anywhere/replicas/ReplicaThreadView.tsx";
import { useAnywhereHistory } from "../state/anywhere-history.ts";
import { InlineRename } from "./InlineRename.tsx";
import { modelLabel, providerLabels, runtimeLabel } from "./labels.ts";
import { ProjectMonogram } from "./ProjectMonogram.tsx";
import { ScriptsBar } from "./project-settings/ScriptsBar.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import { IconBrain } from "./brain/BrainIcons.tsx";

export function TopBar({ macDesktop = false }: { macDesktop?: boolean }) {
  const thread = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined,
  );
  const project = useStore((state) =>
    thread ? state.model.projects[thread.projectId] : undefined,
  );
  const draftView = useStore(isDraftView);
  const draftProject = useStore((state) => {
    const id = draftProjectId(state);
    return id ? state.model.projects[id] : undefined;
  });
  const settingsProject = project ?? draftProject;
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const changesOpen = useStore((state) => state.changes.open);
  const terminalOpen = useStore((state) => state.terminalOpen);
  const canBack = useStore((state) => state.nav.past.length > 0);
  const canForward = useStore((state) => state.nav.future.length > 0);
  const hasProjects = useStore((state) => Object.keys(state.model.projects).length > 0);
  const brainOpen = useStore((state) => state.brainOpen);
  const phone = usePhone();
  const peerThread = useAnywhereHistory((state) => state.replicaView !== null);
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const leadClass = ["topbar-lead", !sidebarOpen && macDesktop ? "desktop-traffic-inset" : null]
    .filter(Boolean)
    .join(" ");

  return (
    <header className="topbar" data-chat-header="">
      <div className={leadClass}>
        {!sidebarOpen ? (
          <Tooltip label="Show sidebar">
            <button
              type="button"
              className="icon-button"
              aria-label="Show sidebar"
              onClick={toggleSidebar}
            >
              {phone ? <IconMenu /> : <IconSidebar />}
            </button>
          </Tooltip>
        ) : null}
        <Tooltip label="Back">
          <button
            type="button"
            className="icon-button"
            aria-label="Back"
            disabled={!canBack}
            onClick={navHistoryBack}
          >
            <IconChevronLeft />
          </button>
        </Tooltip>
        <Tooltip label="Forward">
          <button
            type="button"
            className="icon-button"
            aria-label="Forward"
            disabled={!canForward}
            onClick={navHistoryForward}
          >
            <IconChevronRight />
          </button>
        </Tooltip>
        {!sidebarOpen ? <EnvironmentTag /> : null}
      </div>
      <div className="topbar-title">
        {brainOpen ? (
          <>
            <IconBrain />
            <span className="topbar-draft-title">Brain</span>
          </>
        ) : thread && project ? (
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
        ) : peerThread ? (
          <ReplicaCrumb />
        ) : draftView ? (
          <>
            {draftProject ? <ProjectMonogram name={draftProject.name} /> : <IconFolder />}
            <span className="crumb-project" title={draftProject?.root}>
              {draftProject?.name ?? "No project"}
            </span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="topbar-draft-title">New thread</span>
          </>
        ) : hasProjects ? (
          <span className="topbar-placeholder">Pick a thread</span>
        ) : null}
      </div>
      <div className="topbar-actions">
        <ScriptsBar />
        {settingsProject ? (
          <Tooltip label="Project settings">
            <button
              type="button"
              className="icon-button"
              aria-label="Project settings"
              onClick={() =>
                useStore.setState({
                  dialog: { kind: "projectSettings", projectId: settingsProject.id },
                })
              }
            >
              <IconSliders />
            </button>
          </Tooltip>
        ) : null}
        {thread ? (
          <div className="popover-anchor">
            <Tooltip label="Details">
              <button
                type="button"
                className={detailsOpen ? "icon-button pressed" : "icon-button"}
                aria-label="Thread details"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                <IconDetails />
              </button>
            </Tooltip>
            {detailsOpen ? (
              <DetailsPopover thread={thread} onClose={() => setDetailsOpen(false)} />
            ) : null}
          </div>
        ) : null}
        <Tooltip label="Terminal">
          <button
            type="button"
            className={terminalOpen ? "icon-button pressed" : "icon-button"}
            aria-label="Toggle terminal panel"
            aria-pressed={terminalOpen}
            onClick={toggleTerminal}
          >
            <IconPanelBottom />
          </button>
        </Tooltip>
        <Tooltip label="Changes">
          <button
            type="button"
            className={changesOpen ? "icon-button pressed" : "icon-button"}
            aria-label="Toggle changes panel"
            aria-pressed={changesOpen}
            disabled={!thread}
            onClick={toggleChanges}
          >
            <IconPanelRight />
          </button>
        </Tooltip>
      </div>
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
      className="popover details-popover below end"
      role="dialog"
      aria-label="Thread details"
    >
      <div className="popover-group">
        <div className="popover-row static" title={project?.root}>
          <IconFolder />
          <span className="popover-label mono">{project?.root ?? "Unknown project"}</span>
          {project ? (
            <Tooltip label="Copy path">
              <button
                type="button"
                className="icon-button"
                aria-label="Copy project path"
                onClick={() => void navigator.clipboard.writeText(project.root)}
              >
                <IconCopy />
              </button>
            </Tooltip>
          ) : null}
        </div>
        <div className="popover-row static">
          <ProviderMark kind={thread.provider} />
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
