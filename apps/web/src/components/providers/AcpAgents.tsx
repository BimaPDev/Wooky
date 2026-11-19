import type { AcpAgentConfig } from "@wooky/contracts";
import { useId, useState } from "react";
import { confirm } from "../../state/actions.ts";
import { EnvEditor, ListEditor, Switch } from "./Editors.tsx";
import {
  AGENT_PRESETS,
  agentProblem,
  LIMITS,
  slugify,
  uniqueSlug,
  type AgentPreset,
} from "./helpers.ts";

const blankAgent = (): AcpAgentConfig => ({
  id: "",
  name: "",
  command: "",
  args: [],
  env: {},
  enabled: true,
});

/** One-click starting points for the new-agent form. */
export function AgentPresets({ onPick }: { onPick: (preset: AgentPreset) => void }) {
  return (
    <div className="provider-field">
      <p className="setting-title">Start from a template</p>
      <p className="setting-desc">
        Fills in the form below. Check the agent&apos;s docs, because its flags change between
        releases.
      </p>
      <ul className="agent-presets">
        {AGENT_PRESETS.map((preset) => (
          <li key={preset.id}>
            <button type="button" className="agent-preset" onClick={() => onPick(preset)}>
              <span className="agent-preset-name">{preset.name}</span>
              <code className="agent-preset-command">
                {[preset.command, ...preset.args].join(" ")}
              </code>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Add or edit one ACP agent. In `create` mode nothing is saved until "Add agent". In `edit`
 * mode every valid change is saved. Mount it with a `key` to reset it to `agent`.
 */
export function AgentEditor({
  mode,
  agent,
  otherIds,
  onSave,
  onDelete,
}: {
  mode: "create" | "edit";
  agent: AcpAgentConfig | null;
  otherIds: ReadonlySet<string>;
  onSave: (agent: AcpAgentConfig) => void;
  onDelete?: () => void;
}) {
  const ids = useId();
  const [draft, setDraft] = useState<AcpAgentConfig>(() => agent ?? blankAgent());
  const [idTouched, setIdTouched] = useState(false);
  const problem = agentProblem(draft, otherIds);

  const change = (patch: Partial<AcpAgentConfig>) => {
    let next = { ...draft, ...patch };
    if (mode === "create" && !idTouched && patch.name !== undefined) {
      next = { ...next, id: uniqueSlug(slugify(patch.name), otherIds) };
    }
    if (patch.models !== undefined && patch.models.length === 0) {
      const { models: _unused, ...rest } = next;
      next = rest;
    }
    setDraft(next);
    if (mode === "edit" && agentProblem(next, otherIds) === null) onSave(next);
  };

  const remove = () =>
    confirm({
      title: `Remove ${draft.name || "agent"}`,
      body: "Threads that use it stop working until you add it again. Its settings leave this computer.",
      confirmLabel: "Remove agent",
      onConfirm: () => onDelete?.(),
    });

  return (
    <form
      className="provider-detail-runtime"
      onSubmit={(event) => {
        event.preventDefault();
        if (mode === "create" && problem === null) onSave(draft);
      }}
    >
      <div className="provider-field">
        <label className="setting-title" htmlFor={`${ids}-name`}>
          Name
        </label>
        <input
          id={`${ids}-name`}
          className="provider-input"
          value={draft.name}
          maxLength={LIMITS.agentName}
          placeholder="Gemini CLI"
          autoComplete="off"
          onChange={(event) => change({ name: event.target.value })}
        />
      </div>
      <div className="provider-field">
        <label className="setting-title" htmlFor={`${ids}-id`}>
          Id
        </label>
        <p className="setting-desc">
          {mode === "create"
            ? "Made from the name. Threads refer to the agent by it, so it cannot change after you add it."
            : "Threads refer to the agent by this id, so it cannot change."}
        </p>
        <input
          id={`${ids}-id`}
          className="provider-input mono"
          value={draft.id}
          maxLength={LIMITS.agentId}
          readOnly={mode === "edit"}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setIdTouched(true);
            change({ id: event.target.value });
          }}
        />
      </div>
      <div className="provider-field">
        <label className="setting-title" htmlFor={`${ids}-command`}>
          Command
        </label>
        <p className="setting-desc">
          The program that starts the agent. It runs without a shell, so put its flags under
          arguments.
        </p>
        <input
          id={`${ids}-command`}
          className="provider-input mono"
          value={draft.command}
          maxLength={LIMITS.command}
          placeholder="gemini"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => change({ command: event.target.value })}
        />
      </div>
      <div className="provider-field">
        <p className="setting-title">Arguments</p>
        <p className="setting-desc">One per row.</p>
        <ListEditor
          label="Arguments"
          itemLabel="Argument"
          initial={draft.args}
          max={LIMITS.args}
          maxLength={LIMITS.arg}
          placeholder="--flag"
          onChange={(args) => change({ args })}
        />
      </div>
      <div className="provider-field">
        <p className="setting-title">Models</p>
        <p className="setting-desc">
          Optional. Each one becomes a choice in the model picker, saved as {draft.id || "agent"}
          /model.
        </p>
        <ListEditor
          label="Models"
          itemLabel="Model id"
          initial={draft.models ?? []}
          max={LIMITS.models}
          maxLength={LIMITS.modelId}
          placeholder="model-id"
          onChange={(models) => change({ models })}
        />
      </div>
      <div className="provider-field">
        <p className="setting-title">Environment variables</p>
        <EnvEditor initial={draft.env} onChange={(env) => change({ env })} />
      </div>
      <div className="provider-field provider-field-inline">
        <div>
          <p className="setting-title">Enabled</p>
          <p className="setting-desc">
            A disabled agent stays here but is not offered for threads.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onChange={(enabled) => change({ enabled })}
          label={`Enable ${draft.name || "agent"}`}
        />
      </div>
      {mode === "edit" && problem ? (
        <p className="provider-detail-status error" role="alert">
          {problem} Changes are not saved until this is fixed.
        </p>
      ) : null}
      <div className="agent-actions">
        {mode === "create" ? (
          <>
            <button type="submit" className="button primary" disabled={problem !== null}>
              Add agent
            </button>
            {problem && draft.name !== "" ? (
              <p className="setting-desc" role="status">
                {problem}
              </p>
            ) : null}
          </>
        ) : (
          <button type="button" className="button danger" onClick={remove}>
            Remove agent
          </button>
        )}
      </div>
    </form>
  );
}
