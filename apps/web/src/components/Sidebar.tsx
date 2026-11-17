import type { Project, Thread } from "@age/contracts";
import { memo, useMemo, useState } from "react";
import {
  openDialog,
  removeProject,
  removeThread,
  renameThread,
  selectThread,
} from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { toggleTheme } from "../state/theme.ts";
import { IconFolder, IconEdit, IconPlus, IconTrash } from "./Icons.tsx";
import { InlineRename } from "./InlineRename.tsx";
import { shortcut } from "./labels.ts";

export function Sidebar() {
  const projects = useStore((state) => state.model.projects);
  const threads = useStore((state) => state.model.threads);
  const selected = useStore((state) => state.selectedThreadId);

  const groups = useMemo(() => {
    const byProject = new Map<string, Thread[]>();
    for (const thread of Object.values(threads)) {
      const list = byProject.get(thread.projectId) ?? [];
      list.push(thread);
      byProject.set(thread.projectId, list);
    }
    return Object.values(projects)
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        project,
        threads: (byProject.get(project.id) ?? []).toSorted((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      }));
  }, [projects, threads]);

  return (
    <nav className="sidebar" aria-label="Projects and threads">
      <div className="sidebar-head">
        <span className="brand">AGE</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Add project"
          title="Add project"
          onClick={() => openDialog({ kind: "addProject" })}
        >
          <IconPlus />
        </button>
      </div>
      <div className="sidebar-scroll">
        {groups.length === 0 ? <p className="sidebar-empty">No projects yet.</p> : null}
        {groups.map(({ project, threads: list }) => (
          <ProjectGroup key={project.id} project={project} threads={list} selected={selected} />
        ))}
      </div>
      <div className="sidebar-foot">
        <button
          type="button"
          className="link-button"
          onClick={() => useStore.setState({ paletteOpen: true })}
        >
          Commands <kbd>{shortcut("K")}</kbd>
        </button>
        <button type="button" className="link-button" onClick={toggleTheme}>
          Theme
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
        <IconFolder />
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
          <ThreadRow key={thread.id} thread={thread} active={thread.id === selected} />
        ))}
      </ul>
    </section>
  );
}

const ThreadRow = memo(function ThreadRow({ thread, active }: { thread: Thread; active: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <li className={active ? "thread-row active" : "thread-row"}>
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
            <span className="thread-title">{thread.title || "Untitled thread"}</span>
            <StatusMark status={thread.status} />
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
