import { useState } from "react";
import { renameThread, toggleChanges } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { IconChanges } from "./Icons.tsx";
import { InlineRename } from "./InlineRename.tsx";
import { modelLabel, providerLabels, runtimeLabel } from "./labels.ts";
import { ModelPickerButton } from "./ModelPicker.tsx";

const statusText = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
} as const;

export function TopBar() {
  const thread = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId] : undefined,
  );
  const providers = useStore((state) => state.providers);
  const status = useStore((state) => state.status);
  const fixture = useStore((state) => state.fixture);
  const changesOpen = useStore((state) => state.changes.open);
  const [editing, setEditing] = useState(false);

  return (
    <header className="topbar">
      <div className="topbar-title">
        {thread && editing ? (
          <InlineRename
            className="inline-rename title"
            value={thread.title}
            label="Thread title"
            onDone={(title) => {
              setEditing(false);
              if (title && title !== thread.title) void renameThread(thread.id, title);
            }}
          />
        ) : thread ? (
          <button
            type="button"
            className="title-button"
            title="Rename thread"
            onClick={() => setEditing(true)}
          >
            {thread.title || "Untitled thread"}
          </button>
        ) : null}
      </div>
      {thread ? (
        <div className="topbar-chips">
          <ModelPickerButton thread={thread} className="chip">
            <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
            {providerLabels[thread.provider]} ·{" "}
            {modelLabel(providers, thread.provider, thread.model)}
          </ModelPickerButton>
          <ModelPickerButton thread={thread} className="chip">
            {runtimeLabel(thread.runtimeMode)}
          </ModelPickerButton>
          {thread.worktree ? (
            <span className="chip static mono" title={thread.worktree.path}>
              {thread.worktree.branch}
            </span>
          ) : null}
          <button
            type="button"
            className={changesOpen ? "icon-button pressed" : "icon-button"}
            aria-label="Toggle changes panel"
            aria-pressed={changesOpen}
            title="Changes"
            onClick={toggleChanges}
          >
            <IconChanges />
          </button>
        </div>
      ) : null}
      <span
        className={`connection connection-${status}`}
        role="status"
        title={fixture ? "Fixture data, no server" : statusText[status]}
      >
        <span className="connection-dot" aria-hidden="true" />
        {fixture ? "Fixture" : statusText[status]}
      </span>
    </header>
  );
}
