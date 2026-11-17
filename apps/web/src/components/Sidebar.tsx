import type { Project, Thread } from "@age/contracts";
import { memo, useMemo, useState } from "react";
import {
  openDialog,
  openSettings,
  removeProject,
  removeThread,
  renameThread,
  selectThread,
  toggleSidebar,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import {
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
import { InlineRename } from "./InlineRename.tsx";
import { providerLabels } from "./labels.ts";
import { ProjectMonogram } from "./ProjectMonogram.tsx";

const statusText = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
} as const;

export function Sidebar({ hideBrand = false }: { hideBrand?: boolean }) {
  const projects = useStore((state) => state.model.projects);
  const threads = useStore((state) => state.model.threads);
  const selected = useStore((state) => state.selectedThreadId);
  const groupByProject = useStore((state) => state.deviceSettings?.projectGrouping ?? true);
  const status = useStore((state) => state.status);
  const fixture = useStore((state) => state.fixture);
  const [query, setQuery] = useState("");
  const [workingOpen, setWorkingOpen] = useState(true);

  const needle = query.trim().toLowerCase();
  const { inbox, working, groups } = useMemo(() => {
    const matches = (thread: Thread) =>
      !needle ||
      thread.title.toLowerCase().includes(needle) ||
      (projects[thread.projectId]?.name.toLowerCase().includes(needle) ?? false);
    const all = Object.values(threads)
      .filter((thread) => projects[thread.projectId] && matches(thread))
      .toSorted(
        (a, b) =>
          Number(b.status === "waiting") - Number(a.status === "waiting") ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    const inboxList = all.filter((thread) => thread.status !== "running");
    const byProject = Object.values(projects)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .filter((project) => !needle || inboxList.some((t) => t.projectId === project.id))
      .map((project) => ({
        project,
        threads: inboxList.filter((thread) => thread.projectId === project.id),
      }));
    return {
      inbox: inboxList,
      working: all.filter((thread) => thread.status === "running"),
      groups: byProject,
    };
  }, [projects, threads, needle]);

  const firstProjectId = Object.values(projects)[0]?.id ?? null;
  const hasProjects = firstProjectId !== null;

  return (
    <nav className="sidebar" aria-label="Projects and threads">
      {hideBrand ? null : (
        <div className="sidebar-head">
          <button
            type="button"
            className="icon-button"
            aria-label="Hide sidebar"
            title="Hide sidebar"
            onClick={toggleSidebar}
          >
            <IconSidebar />
          </button>
          <span className="brand">Wooky</span>
        </div>
      )}
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
        <button
          type="button"
          className="icon-button"
          aria-label="Add project"
          title="Add project"
          onClick={() => openDialog({ kind: "addProject" })}
        >
          <IconFolderPlus />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New thread"
          title="New thread"
          disabled={!hasProjects}
          onClick={() => openDialog({ kind: "newThread", projectId: firstProjectId })}
        >
          <IconCompose />
        </button>
      </div>
      <div className="sidebar-scroll">
        {!hasProjects ? (
          <div className="sidebar-empty">
            <p>No projects yet.</p>
            <button
              type="button"
              className="ghost-button"
              onClick={() => openDialog({ kind: "addProject" })}
            >
              <IconFolderPlus />
              Add a project folder
            </button>
          </div>
        ) : null}
        {hasProjects && needle && inbox.length === 0 && working.length === 0 ? (
          <p className="sidebar-empty">No matching threads.</p>
        ) : null}
        {groupByProject ? (
          groups.map(({ project, threads: list }) => (
            <ProjectGroup key={project.id} project={project} threads={list} selected={selected} />
          ))
        ) : (
          <ul className="thread-list">
            {inbox.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                projectName={projects[thread.projectId]?.name ?? ""}
                active={thread.id === selected}
              />
            ))}
          </ul>
        )}
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
            <ul className="thread-list">
              {working.map((thread) => (
                <WorkingRow
                  key={thread.id}
                  thread={thread}
                  projectName={projects[thread.projectId]?.name ?? ""}
                  active={thread.id === selected}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <div className="sidebar-foot">
        <div className="sidebar-foot-utils" role="toolbar" aria-label="Workspace">
          <button
            type="button"
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => openSettings("general")}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Projects"
            title="Projects"
            onClick={() => openSettings("projects")}
          >
            <IconPullRequest />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Usage"
            title="Usage"
            onClick={() => openSettings("usage")}
          >
            <IconChart />
          </button>
        </div>
        <span className="sr-only" role="status">
          {fixture ? "Fixture data, no server" : statusText[status]}
        </span>
        <button
          type="button"
          className="icon-button sidebar-foot-update"
          aria-label="New thread"
          title={hasProjects ? "New thread" : "Add a project first"}
          disabled={!hasProjects}
          onClick={() => openDialog({ kind: "newThread", projectId: firstProjectId })}
        >
          <IconCircleArrowUp />
        </button>
      </div>
    </nav>
  );
}

function ProjectGroup({
  project,
  threads,
  selected,
}: {
  project: Project;
  threads: Thread[];
  selected: string | null;
}) {
  return (
    <section className="project">
      <div className="project-row" title={project.root}>
        <ProjectMonogram name={project.name} />
        <span className="project-name">{project.name}</span>
        <span className="row-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={`New thread in ${project.name}`}
            title="New thread"
            onClick={() => openDialog({ kind: "newThread", projectId: project.id })}
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${project.name}`}
            title="Remove project"
            onClick={() => removeProject(project.id)}
          >
            <IconTrash />
          </button>
        </span>
      </div>
      {threads.length === 0 ? <p className="sidebar-empty indent">No threads.</p> : null}
      <ul className="thread-list">
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            projectName={project.name}
            active={thread.id === selected}
          />
        ))}
      </ul>
    </section>
  );
}

const ThreadCard = memo(function ThreadCard({
  thread,
  projectName,
  active,
}: {
  thread: Thread;
  projectName: string;
  active: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className={active ? "thread-row active" : "thread-row"} data-thread-item="">
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
              <ProjectMonogram name={projectName} />
              <span className="thread-project">{projectName}</span>
              <span className="thread-time">{relativeTime(thread.updatedAt)}</span>
            </span>
            <span className="thread-title">{thread.title || "Untitled thread"}</span>
            <span className="thread-meta">
              <span className="mono">{thread.worktree?.branch ?? "main"}</span>
              <StatusMark status={thread.status} />
              <span
                className={`provider-badge provider-${thread.provider}`}
                title={providerLabels[thread.provider]}
              >
                {thread.provider.slice(0, 2).toUpperCase()}
              </span>
            </span>
          </button>
          <span className="row-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={`Rename ${thread.title}`}
              title="Rename"
              onClick={() => setEditing(true)}
            >
              <IconEdit />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${thread.title}`}
              title="Remove thread"
              onClick={() => removeThread(thread.id)}
            >
              <IconTrash />
            </button>
          </span>
        </>
      )}
    </li>
  );
});

function WorkingRow({
  thread,
  projectName,
  active,
}: {
  thread: Thread;
  projectName: string;
  active: boolean;
}) {
  return (
    <li className={active ? "working-row active" : "working-row"}>
      <button
        type="button"
        className="working-button"
        aria-current={active ? "page" : undefined}
        onClick={() => selectThread(thread.id)}
      >
        <span className="thread-top">
          <ProjectMonogram name={projectName} />
          <span className="thread-project">{projectName}</span>
          <span className="working-label">
            <StatusMark status={thread.status} />
            Working
          </span>
        </span>
        <span className="thread-title">{thread.title || "Untitled thread"}</span>
        <span className="thread-meta">
          <span className="mono">{thread.worktree?.branch ?? "main"}</span>
        </span>
      </button>
    </li>
  );
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
