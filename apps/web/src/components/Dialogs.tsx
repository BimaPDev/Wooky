import type { ProviderKind, RuntimeMode } from "@age/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import {
  addProject,
  closeDialog,
  createThread,
  dispatch,
  sharingThreadsForRevert,
  suggestPaths,
} from "../state/actions.ts";
import { NO_DISABLED_PROVIDERS, useStore, type Dialog } from "../state/store.ts";
import { isAvailable, runtimeModes } from "./labels.ts";
import { Modal } from "./Modal.tsx";
import { defaultModelFor, pickerModels } from "./providers/helpers.ts";

export function Dialogs() {
  const dialog = useStore((state) => state.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "newThread":
      return <NewThreadDialog initialProjectId={dialog.projectId} />;
    case "addProject":
      return <AddProjectDialog />;
    case "confirm":
      return <ConfirmDialog dialog={dialog} />;
    case "revert":
      return <RevertDialog dialog={dialog} />;
  }
}

function RevertDialog({ dialog }: { dialog: Extract<Dialog, { kind: "revert" }> }) {
  const sharing = sharingThreadsForRevert(dialog.threadId);
  const [restoreFiles, setRestoreFiles] = useState(() => sharing.length === 0);
  const [busy, setBusy] = useState(false);

  return (
    <Modal label="Revert to before this turn" onClose={closeDialog} className="modal small">
      <form
        method="dialog"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          const ack = await dispatch({
            type: "turn.revert",
            threadId: dialog.threadId,
            turnId: dialog.turnId,
            restoreFiles,
          });
          setBusy(false);
          if (ack) closeDialog();
        }}
      >
        <h2 className="modal-title">Revert to before this turn</h2>
        <p className="modal-body">
          This turn and later ones leave the conversation. Choose whether to restore files from the
          checkpoint.
        </p>
        {sharing.length > 0 ? (
          <p className="modal-body warn">
            {sharing.length} other {sharing.length === 1 ? "thread shares" : "threads share"} this
            workspace. Restoring files could overwrite their work.
          </p>
        ) : null}
        <fieldset className="revert-choices">
          <legend className="sr-only">Revert scope</legend>
          <label className="option card">
            <input
              type="radio"
              name="revert-scope"
              checked={restoreFiles}
              onChange={() => setRestoreFiles(true)}
            />
            <span>
              <strong>Files and conversation</strong>
              <span className="muted"> · restore the workspace to before this turn</span>
            </span>
          </label>
          <label className="option card">
            <input
              type="radio"
              name="revert-scope"
              checked={!restoreFiles}
              onChange={() => setRestoreFiles(false)}
            />
            <span>
              <strong>Conversation only</strong>
              <span className="muted"> · keep files as they are now</span>
            </span>
          </label>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="button" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button danger" disabled={busy}>
            Revert
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ dialog }: { dialog: Extract<Dialog, { kind: "confirm" }> }) {
  return (
    <Modal label={dialog.title} onClose={closeDialog} className="modal small">
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          closeDialog();
          dialog.onConfirm();
        }}
      >
        <h2 className="modal-title">{dialog.title}</h2>
        <p className="modal-body">{dialog.body}</p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={closeDialog}>
            Cancel
          </button>
          {/* The destructive action is explicit, so focus starts on Cancel. */}
          <button type="submit" className="button danger">
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewThreadDialog({ initialProjectId }: { initialProjectId: string | null }) {
  const projects = useStore((state) => state.model.projects);
  const providers = useStore((state) => state.providers);
  const deviceSettings = useStore((state) => state.deviceSettings);
  const disabledProviders = useStore(
    (state) => state.deviceSettings?.disabledProviders ?? NO_DISABLED_PROVIDERS,
  );
  const disabled = useMemo(() => new Set(disabledProviders), [disabledProviders]);
  const selectedProject = useStore((state) =>
    state.selectedThreadId ? state.model.threads[state.selectedThreadId]?.projectId : undefined,
  );
  const projectList = Object.values(projects).toSorted((a, b) => a.name.localeCompare(b.name));
  const firstAvailable = providers.find((entry) => isAvailable(entry, disabled));

  const [projectId, setProjectId] = useState(
    initialProjectId ?? selectedProject ?? projectList[0]?.id ?? "",
  );
  const [provider, setProvider] = useState<ProviderKind | null>(firstAvailable?.kind ?? null);
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState<RuntimeMode>("approve");
  const [isolate, setIsolate] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = useId();

  const chosen = providers.find((entry) => entry.kind === (provider ?? firstAvailable?.kind));
  const modelOptions = pickerModels(chosen, deviceSettings);
  const chosenModel = model ?? defaultModelFor(chosen, deviceSettings);
  const canCreate = Boolean(projectId && chosen && isAvailable(chosen, disabled) && !busy);

  return (
    <Modal label="New thread" onClose={closeDialog}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canCreate || !chosen) return;
          setBusy(true);
          await createThread({
            projectId,
            provider: chosen.kind,
            model: chosenModel,
            runtimeMode: mode,
            isolate,
          });
          setBusy(false);
          closeDialog();
        }}
      >
        <h2 className="modal-title">New thread</h2>
        {projectList.length === 0 ? (
          <p className="modal-body">Add a project first.</p>
        ) : (
          <label className="field">
            <span>Project</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="field">
          <legend>Agent</legend>
          {providers.length === 0 ? <p className="muted">Checking installed agents.</p> : null}
          <div className="provider-options">
            {providers.map((entry) => (
              <label
                key={entry.kind}
                className={isAvailable(entry, disabled) ? "option card" : "option card disabled"}
              >
                <input
                  type="radio"
                  name={`${ids}-provider`}
                  checked={entry.kind === chosen?.kind}
                  disabled={!isAvailable(entry, disabled)}
                  onChange={() => {
                    setProvider(entry.kind);
                    setModel(null);
                  }}
                />
                <span className={`provider-mark provider-${entry.kind}`} aria-hidden="true" />
                <span className="option-label">{entry.label}</span>
                {entry.version ? <span className="option-meta mono">{entry.version}</span> : null}
                {entry.problem ? <span className="option-note">{entry.problem}</span> : null}
              </label>
            ))}
          </div>
        </fieldset>
        {chosen && modelOptions.length > 0 ? (
          <label className="field">
            <span>Model</span>
            <select value={chosenModel} onChange={(event) => setModel(event.target.value)}>
              {modelOptions.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>Runtime mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as RuntimeMode)}>
            {runtimeModes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={isolate}
            onChange={(event) => setIsolate(event.target.checked)}
          />
          <span>
            Isolated worktree
            <span className="muted"> · the thread works on its own branch and checkout</span>
          </span>
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!canCreate}>
            Create thread
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddProjectDialog() {
  const [path, setPath] = useState("");
  const [suggestions, setSuggestions] = useState<{ path: string; isGitRepo: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  // sync: server fs.pickable suggestions for the typed path
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      suggestPaths(path.trim()).then(
        (result) => !cancelled && setSuggestions(result.slice(0, 8)),
        () => !cancelled && setSuggestions([]),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path]);

  const submit = async (root: string) => {
    if (!root.trim() || busy) return;
    setBusy(true);
    const ack = await addProject(root.trim());
    setBusy(false);
    if (ack) closeDialog();
  };

  return (
    <Modal label="Add project" onClose={closeDialog}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(path);
        }}
      >
        <h2 className="modal-title">Add project</h2>
        <label className="field">
          <span>Folder path</span>
          <input
            className="mono"
            value={path}
            placeholder="/Users/you/code/project"
            spellCheck={false}
            autoComplete="off"
            aria-controls={listId}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <ul className="suggestions" id={listId} aria-label="Suggested folders">
          {suggestions.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="suggestion"
                onClick={() => setPath(entry.path)}
                onDoubleClick={() => void submit(entry.path)}
              >
                <span className="mono">{entry.path}</span>
                {entry.isGitRepo ? <span className="muted">git</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button type="button" className="button" onClick={closeDialog}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!path.trim() || busy}>
            Add project
          </button>
        </div>
      </form>
    </Modal>
  );
}
