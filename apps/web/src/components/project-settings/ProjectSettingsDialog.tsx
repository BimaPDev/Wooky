import type { ProjectPrompt, ProjectScript, ProjectSettings, SharedPath } from "@wooky/contracts";
import { useId, useState } from "react";
import { dispatch } from "../../state/actions.ts";
import { backend } from "../../state/backend.ts";
import { useStore } from "../../state/store.ts";
import { IconClose, IconPlus, IconTrash } from "../Icons.tsx";
import { Modal } from "../Modal.tsx";
import { SCRIPT_ICONS, ScriptIcon } from "./icons.tsx";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function emptyScript(): ProjectScript {
  return { id: newId("script"), name: "", command: "", runOnWorktreeCreate: false };
}

function emptyPrompt(): ProjectPrompt {
  return { id: newId("prompt"), name: "", text: "" };
}

export function ProjectSettingsDialog({ projectId }: { projectId: string }) {
  const project = useStore((state) => state.model.projects[projectId]);
  const [scripts, setScripts] = useState<ProjectScript[]>(() => [
    ...(project?.settings.scripts ?? []),
  ]);
  const [sharedPaths, setSharedPaths] = useState<SharedPath[]>(
    () => project?.settings.sharedPaths ?? [],
  );
  const [prompts, setPrompts] = useState<ProjectPrompt[]>(() => project?.settings.prompts ?? []);
  const [worktreeSetup, setWorktreeSetup] = useState(project?.settings.worktreeSetup ?? "");
  const [defaultPreviewUrl, setDefaultPreviewUrl] = useState(
    project?.settings.defaultPreviewUrl ?? "",
  );
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  if (!project) return null;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const settings: ProjectSettings = {
      scripts: scripts.filter((script) => script.name.trim() && script.command.trim()),
      sharedPaths: sharedPaths.filter((entry) => entry.path.trim()),
      prompts: prompts.filter((prompt) => prompt.name.trim() && prompt.text.trim()),
      ...(worktreeSetup.trim() ? { worktreeSetup: worktreeSetup.trim() } : {}),
      ...(defaultPreviewUrl.trim() ? { defaultPreviewUrl: defaultPreviewUrl.trim() } : {}),
    };
    const ack = await dispatch({ type: "project.configure", projectId, settings });
    setBusy(false);
    if (ack) useStore.setState({ dialog: null });
  };

  const suggest = async () => {
    try {
      const paths = await backend().call("scripts.suggestSharedPaths", { projectId });
      setSuggested(paths);
    } catch {
      setSuggested([]);
    }
  };

  return (
    <Modal
      label={`Project settings for ${project.name}`}
      onClose={() => useStore.setState({ dialog: null })}
      className="modal project-settings-modal"
    >
      <form
        id={formId}
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="modal-title">Project settings</h2>
        <p className="modal-body">{project.name}</p>

        <h3 className="settings-section-title">Scripts</h3>
        <ul className="settings-list">
          {scripts.map((script, index) => (
            <li key={script.id} className="settings-card">
              <label className="field">
                <span>Name</span>
                <input
                  value={script.name}
                  onChange={(event) =>
                    setScripts((current) =>
                      current.map((item) =>
                        item.id === script.id ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Command</span>
                <input
                  className="mono"
                  value={script.command}
                  onChange={(event) =>
                    setScripts((current) =>
                      current.map((item) =>
                        item.id === script.id ? { ...item, command: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <fieldset className="field">
                <legend>Icon</legend>
                <div className="icon-picker">
                  {SCRIPT_ICONS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={script.icon === name ? "icon-pick selected" : "icon-pick"}
                      aria-label={name}
                      aria-pressed={script.icon === name}
                      onClick={() =>
                        setScripts((current) =>
                          current.map((item) =>
                            item.id === script.id ? { ...item, icon: name } : item,
                          ),
                        )
                      }
                    >
                      <ScriptIcon name={name} />
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={script.runOnWorktreeCreate}
                  onChange={(event) =>
                    setScripts((current) =>
                      current.map((item) =>
                        item.id === script.id
                          ? { ...item, runOnWorktreeCreate: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <span>Run when a worktree is created</span>
              </label>
              <label className="field">
                <span>Preview URL</span>
                <input
                  className="mono"
                  value={script.previewUrl ?? ""}
                  placeholder="http://localhost:${PORT}"
                  onChange={(event) =>
                    setScripts((current) =>
                      current.map((item) =>
                        item.id === script.id
                          ? { ...item, previewUrl: event.target.value || undefined }
                          : item,
                      ),
                    )
                  }
                />
              </label>
              <div className="settings-row-actions">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={index === 0}
                  onClick={() =>
                    setScripts((current) => {
                      if (index === 0) return current;
                      const next = [...current];
                      const [moved] = next.splice(index, 1);
                      if (moved) next.splice(index - 1, 0, moved);
                      return next;
                    })
                  }
                >
                  Move up
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={index === scripts.length - 1}
                  onClick={() =>
                    setScripts((current) => {
                      if (index >= current.length - 1) return current;
                      const next = [...current];
                      const [moved] = next.splice(index, 1);
                      if (moved) next.splice(index + 1, 0, moved);
                      return next;
                    })
                  }
                >
                  Move down
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  aria-label={`Delete ${script.name || "script"}`}
                  onClick={() =>
                    setScripts((current) => current.filter((item) => item.id !== script.id))
                  }
                >
                  <IconTrash />
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="ghost-button"
          onClick={() => setScripts((current) => [...current, emptyScript()])}
        >
          <IconPlus /> Add script
        </button>

        <h3 className="settings-section-title">Worktree setup</h3>
        <p className="settings-help">
          Runs in a terminal in each new worktree, for example to install dependencies. The agent
          starts at the same time and does not wait for it to finish.
        </p>
        <label className="field">
          <span>Setup command</span>
          <input
            className="mono"
            value={worktreeSetup}
            placeholder="pnpm install"
            onChange={(event) => setWorktreeSetup(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Default preview URL</span>
          <input
            className="mono"
            value={defaultPreviewUrl}
            placeholder="http://localhost:${PORT}"
            onChange={(event) => setDefaultPreviewUrl(event.target.value)}
          />
        </label>

        <h3 className="settings-section-title">Shared files</h3>
        <ul className="settings-list">
          {sharedPaths.map((entry, index) => (
            <li key={`${entry.path}-${index}`} className="settings-inline">
              <input
                className="mono"
                value={entry.path}
                placeholder=".env"
                onChange={(event) =>
                  setSharedPaths((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, path: event.target.value } : item,
                    ),
                  )
                }
              />
              <select
                value={entry.mode}
                onChange={(event) =>
                  setSharedPaths((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, mode: event.target.value as SharedPath["mode"] }
                        : item,
                    ),
                  )
                }
              >
                <option value="link">Link</option>
                <option value="copy">Copy</option>
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${entry.path || "path"}`}
                onClick={() =>
                  setSharedPaths((current) => current.filter((_, itemIndex) => itemIndex !== index))
                }
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
        <div className="settings-row-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => setSharedPaths((current) => [...current, { path: "", mode: "link" }])}
          >
            <IconPlus /> Add path
          </button>
          <button type="button" className="ghost-button" onClick={() => void suggest()}>
            Suggest
          </button>
        </div>
        {suggested ? (
          <ul className="suggestions" aria-label="Suggested shared paths">
            {suggested.length === 0 ? (
              <li className="muted">
                Nothing to suggest. This project has no gitignored files or folders at its top level
                (such as .env or node_modules). You can still add a path by hand.
              </li>
            ) : (
              suggested.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="suggestion"
                    onClick={() =>
                      setSharedPaths((current) =>
                        current.some((item) => item.path === path)
                          ? current
                          : [...current, { path, mode: "link" }],
                      )
                    }
                  >
                    {path}
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}

        <h3 className="settings-section-title">Prompt presets</h3>
        <ul className="settings-list">
          {prompts.map((prompt) => (
            <li key={prompt.id} className="settings-card">
              <label className="field">
                <span>Name</span>
                <input
                  value={prompt.name}
                  onChange={(event) =>
                    setPrompts((current) =>
                      current.map((item) =>
                        item.id === prompt.id ? { ...item, name: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Text</span>
                <textarea
                  value={prompt.text}
                  rows={3}
                  onChange={(event) =>
                    setPrompts((current) =>
                      current.map((item) =>
                        item.id === prompt.id ? { ...item, text: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="ghost-button"
                aria-label={`Delete ${prompt.name || "prompt"}`}
                onClick={() =>
                  setPrompts((current) => current.filter((item) => item.id !== prompt.id))
                }
              >
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="ghost-button"
          onClick={() => setPrompts((current) => [...current, emptyPrompt()])}
        >
          <IconPlus /> Add prompt
        </button>

        <div className="modal-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => useStore.setState({ dialog: null })}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
