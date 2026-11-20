import type { FleetStatus, Project, Thread, ThreadGroup } from "@wooky/contracts";
import { memo, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  isSettledStatus,
  isWorkingStatus,
  partitionSidebarThreads,
} from "../lib/sidebar-sections.ts";
import {
  openCompare,
  openFleetBoard,
  openInSplit,
  openNewThread,
  openSettings,
  pickProjectFolder,
  removeProject,
  removeThread,
  renameThread,
  selectThread,
  toggleSidebar,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import {
  IconBot,
  IconChart,
  IconChevron,
  IconCircleArrowUp,
  IconCompose,
  IconEdit,
  IconFolderPlus,
  IconPlus,
  IconPullRequest,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTrash,
} from "./Icons.tsx";
import { ConflictBadge } from "./anywhere/conflicts/ConflictBadge.tsx";
import { ReplicaSections } from "./anywhere/replicas/ReplicaSections.tsx";
import { InlineRename } from "./InlineRename.tsx";
import { providerLabels } from "./labels.ts";
import { ProjectMonogram } from "./ProjectMonogram.tsx";
import { Tooltip } from "./Tooltip.tsx";
import {
  buildSidebarTree,
  promptPreview,
  selectFleetStatusById,
  summarizeStatuses,
  workerCountLabel,
  type SidebarTreeNode,
} from "./fleet/helpers.ts";

const statusText = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
} as const;

export function Sidebar({ macDesktop = false }: { macDesktop?: boolean }) {
  const model = useStore((state) => state.model);
  const projects = model.projects;
  const threads = model.threads;
  const fleetGroups = model.groups;
  const statusById = selectFleetStatusById(model);
  const selected = useStore((state) => state.selectedThreadId);
  const groupByProject = useStore((state) => state.deviceSettings?.projectGrouping ?? true);
  const status = useStore((state) => state.status);
  const fixture = useStore((state) => state.fixture);
  const pickingFolder = useStore((state) => state.pickingFolder);
  const [query, setQuery] = useState("");
  const [workingOpen, setWorkingOpen] = useState(true);
  const [settledOpen, setSettledOpen] = useState(false);

  const needle = query.trim().toLowerCase();
  const { working, settled, groups, all, hasProjects, settledInScroll } = useMemo(() => {
    const matches = (thread: Thread) =>
      !needle ||
      thread.title.toLowerCase().includes(needle) ||
      (projects[thread.projectId]?.name.toLowerCase().includes(needle) ?? false);
    const matched = Object.values(threads)
      .filter((thread) => projects[thread.projectId] && matches(thread))
      .toSorted(
        (a, b) =>
          Number(b.status === "waiting") - Number(a.status === "waiting") ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    const parts = partitionSidebarThreads(matched);
    // Expanded Settled lists its own threads, so keep them out of the groups to avoid duplicates.
    const includeSettledInGroups = !settledOpen;
    const inProjectList = matched.filter((thread) => {
      if (isWorkingStatus(thread.status)) return false;
      if (isSettledStatus(thread.status) && !includeSettledInGroups) return false;
      return true;
    });
    const byProject = Object.values(projects)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .filter((project) => !needle || inProjectList.some((t) => t.projectId === project.id))
      .map((project) => ({
        project,
        threads: inProjectList.filter((thread) => thread.projectId === project.id),
      }));
    return {
      working: parts.working,
      settled: parts.settled,
      groups: byProject,
      all: matched,
      hasProjects: Object.values(projects).length > 0,
      settledInScroll: includeSettledInGroups,
    };
  }, [projects, threads, needle, settledOpen]);

  return (
    <nav className="sidebar" data-workspace-area="sidebar" aria-label="Projects and threads">
      <div className={macDesktop ? "sidebar-head desktop-traffic-inset" : "sidebar-head"}>
        <Tooltip label="Hide sidebar">
          <button
            type="button"
            className="icon-button"
            aria-label="Hide sidebar"
            onClick={toggleSidebar}
          >
            <IconSidebar />
          </button>
        </Tooltip>
        <span className="brand">Wooky</span>
      </div>
      <div className="sidebar-tools">
        <label className="search-field">
          <IconSearch />
          <input
            value={query}
            placeholder="Search"
            aria-label="Search threads"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Tooltip label="Add project">
          <button
            type="button"
            className="icon-button"
            aria-label="Add project"
            aria-busy={pickingFolder}
            disabled={pickingFolder}
            onClick={() => void pickProjectFolder()}
          >
            <IconFolderPlus />
          </button>
        </Tooltip>
        <Tooltip label="Agent board">
          <button
            type="button"
            className="icon-button"
            aria-label="Open agent board"
            onClick={openFleetBoard}
          >
            <IconBot />
          </button>
        </Tooltip>
        <Tooltip label="New thread">
          <button
            type="button"
            className="icon-button"
            aria-label="New thread"
            onClick={() => openNewThread()}
          >
            <IconCompose />
          </button>
        </Tooltip>
      </div>
      <ConflictBadge />
      <div className="sidebar-scroll">
        {hasProjects &&
        needle &&
        working.length === 0 &&
        settled.length === 0 &&
        groups.every((g) => g.threads.length === 0) ? (
          <p className="sidebar-empty">No matching threads.</p>
        ) : null}
        {groupByProject ? (
          groups.map(({ project, threads: list }) => (
            <ProjectGroup
              key={project.id}
              project={project}
              threads={list}
              allThreads={all.filter((thread) => thread.projectId === project.id)}
              groups={fleetGroups}
              selected={selected}
              grouped
              statusById={statusById}
            />
          ))
        ) : (
          <ThreadTree
            visible={groups.flatMap((group) => group.threads)}
            allThreads={all}
            groups={fleetGroups}
            selected={selected}
            grouped={false}
            projectName={(id) => projects[id]?.name ?? ""}
            statusById={statusById}
          />
        )}
        <ReplicaSections />
      </div>
      {working.length > 0 ? (
        <section className="sidebar-working" aria-label="Working">
          <button
            type="button"
            className="sidebar-section-toggle"
            aria-expanded={workingOpen}
            onClick={() => setWorkingOpen(!workingOpen)}
          >
            <span>Working</span>
            <span className="sidebar-section-count">{working.length}</span>
            <IconChevron open={workingOpen} />
          </button>
          {workingOpen ? (
            <ThreadTree
              visible={working}
              allThreads={all}
              groups={fleetGroups}
              selected={selected}
              grouped={false}
              projectName={(id) => projects[id]?.name ?? ""}
              statusById={statusById}
            />
          ) : null}
        </section>
      ) : null}
      {settled.length > 0 ? (
        <section className="sidebar-settled" aria-label="Settled">
          <button
            type="button"
            className="sidebar-section-toggle"
            aria-expanded={settledOpen}
            onClick={() => setSettledOpen(!settledOpen)}
          >
            <span>Settled</span>
            <span className="sidebar-section-count">{settled.length}</span>
            <IconChevron open={settledOpen} />
          </button>
          {settledOpen ? (
            <ThreadTree
              visible={settled}
              allThreads={all}
              groups={fleetGroups}
              selected={selected}
              grouped={false}
              projectName={(id) => projects[id]?.name ?? ""}
              statusById={statusById}
            />
          ) : settledInScroll ? null : (
            <p className="sidebar-settled-hint">Expand to browse idle threads.</p>
          )}
        </section>
      ) : null}
      <div className="sidebar-foot">
        <div className="sidebar-foot-utils" role="toolbar" aria-label="Workspace">
          <Tooltip label="Settings">
            <button
              type="button"
              className="icon-button"
              aria-label="Settings"
              onClick={() => openSettings("general")}
            >
              <IconSettings />
            </button>
          </Tooltip>
          <Tooltip label="Projects">
            <button
              type="button"
              className="icon-button"
              aria-label="Projects"
              onClick={() => openSettings("projects")}
            >
              <IconPullRequest />
            </button>
          </Tooltip>
          <Tooltip label="Usage">
            <button
              type="button"
              className="icon-button"
              aria-label="Usage"
              onClick={() => openSettings("usage")}
            >
              <IconChart />
            </button>
          </Tooltip>
        </div>
        <span className="sr-only" role="status">
          {fixture ? "Fixture data, no server" : statusText[status]}
        </span>
        <Tooltip label="New thread" className="sidebar-foot-update">
          <button
            type="button"
            className="icon-button"
            aria-label="New thread"
            onClick={() => openNewThread()}
          >
            <IconCircleArrowUp />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

function ProjectGroup({
  project,
  threads,
  allThreads,
  groups,
  selected,
  grouped,
  statusById,
}: {
  project: Project;
  threads: Thread[];
  allThreads: Thread[];
  groups: Record<string, ThreadGroup>;
  selected: string | null;
  grouped: boolean;
  statusById: Readonly<Record<string, FleetStatus>>;
}) {
  if (threads.length === 0) return null;
  return (
    <section className="project">
      <div className="project-row" title={project.root}>
        <ProjectMonogram name={project.name} />
        <span className="project-name">{project.name}</span>
        <span className="row-actions">
          <Tooltip label="New thread">
            <button
              type="button"
              className="icon-button"
              aria-label={`New thread in ${project.name}`}
              onClick={() => openNewThread(project.scratch ? null : project.id)}
            >
              <IconPlus />
            </button>
          </Tooltip>
          {project.scratch ? null : (
            <Tooltip label="Remove project">
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${project.name}`}
                onClick={() => removeProject(project.id)}
              >
                <IconTrash />
              </button>
            </Tooltip>
          )}
        </span>
      </div>
      <ThreadTree
        visible={threads}
        allThreads={allThreads}
        groups={groups}
        selected={selected}
        grouped={grouped}
        projectName={() => project.name}
        statusById={statusById}
      />
    </section>
  );
}

function ThreadTree({
  visible,
  allThreads,
  groups,
  selected,
  grouped,
  projectName,
  statusById,
}: {
  visible: Thread[];
  allThreads: Thread[];
  groups: Record<string, ThreadGroup>;
  selected: string | null;
  grouped: boolean;
  projectName: (projectId: string) => string;
  statusById: Readonly<Record<string, FleetStatus>>;
}) {
  const nodes = useMemo(
    () => buildSidebarTree(visible, allThreads, groups),
    [visible, allThreads, groups],
  );
  if (nodes.length === 0) return null;
  return (
    <ul className="thread-list">
      {nodes.map((node) => (
        <TreeNode
          key={treeKey(node)}
          node={node}
          selected={selected}
          grouped={grouped}
          projectName={projectName}
          statusById={statusById}
        />
      ))}
    </ul>
  );
}

function treeKey(node: SidebarTreeNode): string {
  if (node.kind === "group") return `g:${node.group.id}`;
  return node.thread.id;
}

function TreeNode({
  node,
  selected,
  grouped,
  projectName,
  statusById,
}: {
  node: SidebarTreeNode;
  selected: string | null;
  grouped: boolean;
  projectName: (projectId: string) => string;
  statusById: Readonly<Record<string, FleetStatus>>;
}) {
  if (node.kind === "thread" || node.kind === "orphaned") {
    return (
      <ThreadCard
        thread={node.thread}
        projectName={projectName(node.thread.projectId)}
        active={node.thread.id === selected}
        grouped={grouped}
        badge={node.kind === "orphaned" ? "Orphaned worker" : undefined}
      />
    );
  }
  if (node.kind === "coordinator") {
    return (
      <CoordinatorNode
        thread={node.thread}
        workers={node.workers}
        selected={selected}
        grouped={grouped}
        projectName={projectName}
        statusById={statusById}
      />
    );
  }
  return (
    <FanoutNode
      group={node.group}
      threads={node.threads}
      selected={selected}
      grouped={grouped}
      projectName={projectName}
      statusById={statusById}
    />
  );
}

function CoordinatorNode({
  thread,
  workers,
  selected,
  grouped,
  projectName,
  statusById,
}: {
  thread: Thread;
  workers: Thread[];
  selected: string | null;
  grouped: boolean;
  projectName: (projectId: string) => string;
  statusById: Readonly<Record<string, FleetStatus>>;
}) {
  const waiting = workers.filter((worker) => statusById[worker.id] === "waiting").length;
  const defaultOpen = waiting > 0 || workers.some((worker) => statusById[worker.id] === "working");
  const [open, setOpen] = useState(defaultOpen);
  const splitMenu = useSplitContextMenu(thread.id);
  return (
    <li className="fleet-tree-item">
      <div
        className={thread.id === selected ? "thread-row active" : "thread-row"}
        onContextMenu={splitMenu.onContextMenu}
      >
        <Tooltip label={open ? "Collapse workers" : "Expand workers"}>
          <button
            type="button"
            className="icon-button fleet-tree-toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse workers" : "Expand workers"}
            onClick={() => setOpen(!open)}
          >
            <IconChevron open={open} />
          </button>
        </Tooltip>
        <button
          type="button"
          className="thread-button"
          aria-current={thread.id === selected ? "page" : undefined}
          onClick={() => selectThread(thread.id)}
        >
          <span className="thread-top">
            {grouped ? null : <ProjectMonogram name={projectName(thread.projectId)} />}
            <span className="thread-title">{thread.title || "Untitled thread"}</span>
          </span>
          <span className="thread-meta">
            <span className="fleet-tree-badge">{workerCountLabel(workers.length, waiting)}</span>
            <StatusMark status={thread.status} />
          </span>
        </button>
      </div>
      {open ? (
        <ul className="fleet-nest">
          {workers.map((worker) => (
            <ThreadCard
              key={worker.id}
              thread={worker}
              projectName={projectName(worker.projectId)}
              active={worker.id === selected}
              grouped={grouped}
            />
          ))}
        </ul>
      ) : null}
      {splitMenu.node}
    </li>
  );
}

function FanoutNode({
  group,
  threads,
  selected,
  grouped,
  projectName,
  statusById,
}: {
  group: ThreadGroup;
  threads: Thread[];
  selected: string | null;
  grouped: boolean;
  projectName: (projectId: string) => string;
  statusById: Readonly<Record<string, FleetStatus>>;
}) {
  const [open, setOpen] = useState(true);
  const summary = summarizeStatuses(threads.map((thread) => statusById[thread.id] ?? "idle"));
  const title = promptPreview(group.prompt);
  return (
    <li className="fleet-tree-item">
      <div className="thread-row">
        <Tooltip label={open ? "Collapse group" : "Expand group"}>
          <button
            type="button"
            className="icon-button fleet-tree-toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse group" : "Expand group"}
            onClick={() => setOpen(!open)}
          >
            <IconChevron open={open} />
          </button>
        </Tooltip>
        <button
          type="button"
          className="thread-button"
          aria-label={`Compare ${title}`}
          onClick={() => openCompare(group.id)}
        >
          <span className="thread-top">
            <span className="thread-title">{title}</span>
          </span>
          <span className="thread-meta">
            <span className="fleet-tree-badge">{summary}</span>
          </span>
        </button>
      </div>
      {open ? (
        <ul className="fleet-nest">
          {threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              projectName={projectName(thread.projectId)}
              active={thread.id === selected}
              grouped={grouped}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const ThreadCard = memo(function ThreadCard({
  thread,
  projectName,
  active,
  grouped,
  badge,
}: {
  thread: Thread;
  projectName: string;
  active: boolean;
  grouped: boolean;
  badge?: string;
}) {
  const [editing, setEditing] = useState(false);
  const splitMenu = useSplitContextMenu(thread.id);
  return (
    <li
      className={active ? "thread-row active" : "thread-row"}
      data-thread-item=""
      onContextMenu={splitMenu.onContextMenu}
    >
      {editing ? (
        <InlineRename
          value={thread.title}
          label="Thread title"
          onDone={(title) => {
            setEditing(false);
            if (title && title !== thread.title) void renameThread(thread.id, title);
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="thread-button"
            aria-current={active ? "page" : undefined}
            onClick={() => selectThread(thread.id)}
            onDoubleClick={() => setEditing(true)}
          >
            <span className="thread-top">
              {grouped ? null : <ProjectMonogram name={projectName} />}
              <span className="thread-title">{thread.title || "Untitled thread"}</span>
              <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
            </span>
            <span className="thread-meta">
              {badge ? <span className="fleet-tree-badge">{badge}</span> : null}
              <span
                className={`provider-badge provider-${thread.provider}`}
                title={providerLabels[thread.provider]}
              >
                {thread.provider.slice(0, 2).toUpperCase()}
              </span>
              <StatusMark status={thread.status} />
            </span>
          </button>
          <span className="row-actions">
            <Tooltip label="Rename">
              <button
                type="button"
                className="icon-button"
                aria-label={`Rename ${thread.title}`}
                onClick={() => setEditing(true)}
              >
                <IconEdit />
              </button>
            </Tooltip>
            <Tooltip label="Remove thread">
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${thread.title}`}
                onClick={() => removeThread(thread.id)}
              >
                <IconTrash />
              </button>
            </Tooltip>
          </span>
        </>
      )}
      {splitMenu.node}
    </li>
  );
});

function useSplitContextMenu(threadId: string): {
  onContextMenu: (event: MouseEvent) => void;
  node: ReactNode;
} {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // sync: dismiss the thread context menu on outside pointer, escape, or scroll
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-thread-split-menu]")) {
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  return {
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY });
    },
    node: menu ? (
      <div
        className="fleet-context"
        data-thread-split-menu=""
        role="menu"
        style={{ top: menu.y, left: menu.x }}
      >
        <button
          type="button"
          className="fleet-context-item"
          role="menuitem"
          onClick={() => {
            useStore.setState({ fleetBoardOpen: false, compareGroupId: null });
            openInSplit(threadId);
            setMenu(null);
          }}
        >
          Open in split
        </button>
      </div>
    ) : null,
  };
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function StatusMark({ status }: { status: Thread["status"] }) {
  switch (status) {
    case "running":
      return <span className="working" role="img" aria-label="Working" />;
    case "waiting":
      return <span className="dot dot-amber" role="img" aria-label="Waiting for you" />;
    case "error":
      return <span className="dot dot-red" role="img" aria-label="Error" />;
    case "idle":
      return null;
  }
}
