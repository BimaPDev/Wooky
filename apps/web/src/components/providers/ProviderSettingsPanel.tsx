import type { ProviderKind, ProviderSettings, ProviderStatus } from "@wooky/contracts";
import { useId, useState } from "react";
import { IconClose } from "../Icons.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { EnvEditor, ListEditor } from "./Editors.tsx";
import { checkNewModelId, emptyProviderSettings, groupModels, LIMITS } from "./helpers.ts";

/** What each CLI is called on PATH, shown as the placeholder when no path is set. */
const BINARY_HINT: Record<ProviderKind, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  opencode: "opencode",
  demo: "",
  acp: "",
};

const ARGS_NOTE: Partial<Record<ProviderKind, string>> = {
  claude:
    "Claude runs through the Agent SDK, which takes long flags only, such as --max-turns 4 or --max-turns=4. Short flags and bare words are ignored.",
  cursor: "Added before the prompt on each turn, not on version or model checks.",
  codex: "Added after app-server when Codex starts, not on the version check.",
  opencode: "Added to the arguments Wooky passes when it starts OpenCode.",
};

/** Binary, models and advanced options for one provider. Edits go up through `onChange`. */
export function ProviderSettingsPanel({
  kind,
  status,
  settings,
  busy,
  onChange,
}: {
  kind: ProviderKind;
  status: ProviderStatus;
  settings: ProviderSettings | undefined;
  /** True while a save or the re-check after it is still running. */
  busy: boolean;
  onChange: (patch: Partial<ProviderSettings>) => void;
}) {
  const current = settings ?? emptyProviderSettings();
  const hasBinary = BINARY_HINT[kind] !== "";
  return (
    <div className="provider-detail-runtime">
      {hasBinary ? (
        <BinaryField
          hint={BINARY_HINT[kind]}
          status={status}
          value={current.binaryPath ?? ""}
          busy={busy}
          onChange={(binaryPath) =>
            onChange({ binaryPath: binaryPath === "" ? undefined : binaryPath })
          }
        />
      ) : null}
      <ModelsField status={status} settings={current} onChange={onChange} />
      {kind === "demo" ? null : (
        <details className="provider-advanced">
          <summary>Advanced</summary>
          <div className="provider-advanced-body">
            <div className="provider-field">
              <p className="setting-title">Extra arguments</p>
              <p className="setting-desc">One per row. {ARGS_NOTE[kind] ?? ""}</p>
              <ListEditor
                label="Extra arguments"
                itemLabel="Argument"
                initial={current.extraArgs}
                max={LIMITS.args}
                maxLength={LIMITS.arg}
                placeholder="--flag"
                onChange={(extraArgs) => onChange({ extraArgs })}
              />
            </div>
            <div className="provider-field">
              <p className="setting-title">Environment variables</p>
              <p className="setting-desc">Added to the environment the CLI starts with.</p>
              <EnvEditor initial={current.env} onChange={(env) => onChange({ env })} />
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function BinaryField({
  hint,
  status,
  value,
  busy,
  onChange,
}: {
  hint: string;
  status: ProviderStatus;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const set = value.trim() !== "";
  const failed = set && !busy && !status.installed;
  const found = set && !busy && status.installed;
  return (
    <div className="provider-field">
      <label className="setting-title" htmlFor={`${id}-binary`}>
        Binary
      </label>
      <p className="setting-desc" id={`${id}-binary-help`}>
        The full path to the CLI. Leave it empty to use <code className="mono">{hint}</code> from
        your PATH.
      </p>
      <div className="provider-binary-row">
        <input
          id={`${id}-binary`}
          className="provider-input mono"
          value={value}
          maxLength={LIMITS.binaryPath}
          placeholder={hint}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={failed}
          aria-describedby={`${id}-binary-help ${id}-binary-note`}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="ghost-button" disabled={!set} onClick={() => onChange("")}>
          Reset
        </button>
      </div>
      <p
        id={`${id}-binary-note`}
        className={failed ? "provider-detail-status error" : "setting-desc"}
        role={failed ? "alert" : "status"}
      >
        {set && busy
          ? "Checking."
          : failed
            ? (status.problem ?? "Wooky could not run this binary.")
            : found
              ? `Found${status.version ? `, version ${status.version}` : ""}.`
              : ""}
      </p>
    </div>
  );
}

function ModelsField({
  status,
  settings,
  onChange,
}: {
  status: ProviderStatus;
  settings: ProviderSettings;
  onChange: (patch: Partial<ProviderSettings>) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const groups = groupModels(status, settings.customModels);
  const listed = groups.flatMap((group) => group.models);
  const listedIds = status.models.map((model) => model.id);
  const defaultId = settings.defaultModel ?? "";
  const defaultListed = defaultId === "" || listed.some((model) => model.id === defaultId);

  const add = () => {
    const check = checkNewModelId(text, listedIds, settings.customModels);
    if (!check.ok) {
      setProblem(check.message);
      return;
    }
    setProblem(null);
    setText("");
    onChange({ customModels: [...settings.customModels, check.id] });
  };

  const remove = (modelId: string) =>
    onChange({
      customModels: settings.customModels.filter((entry) => entry !== modelId),
      ...(settings.defaultModel === modelId ? { defaultModel: undefined } : {}),
    });

  return (
    <div className="provider-field">
      <p className="setting-title">Models</p>
      <p className="setting-desc">
        {listed.length > 0
          ? "Pick one in the composer. Add an id the list is missing."
          : "None reported yet. Add an id to use one anyway."}
      </p>
      {groups.map((group) => (
        <div className="provider-model-group" key={group.source}>
          <p className="provider-model-group-title">{group.title}</p>
          <ul className="provider-chips" aria-label={group.title}>
            {group.models.map((model) => (
              <li className="provider-chip" key={model.id} title={model.id}>
                <span>{model.label}</span>
                {model.id === settings.defaultModel ? (
                  <span className="provider-chip-note">Default</span>
                ) : null}
                {group.source === "custom" ? (
                  <Tooltip label="Remove">
                    <button
                      type="button"
                      className="provider-chip-remove"
                      aria-label={`Remove ${model.id}`}
                      onClick={() => remove(model.id)}
                    >
                      <IconClose />
                    </button>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form
        className="provider-binary-row"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="provider-input mono"
          value={text}
          maxLength={LIMITS.modelId + 1}
          placeholder="Add model id"
          aria-label="Add model id"
          aria-invalid={problem !== null}
          aria-describedby={`${id}-model-problem`}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
        />
        <button type="submit" className="ghost-button" disabled={text.trim() === ""}>
          Add
        </button>
      </form>
      <p
        id={`${id}-model-problem`}
        className="provider-detail-status error"
        role="alert"
        hidden={problem === null}
      >
        {problem}
      </p>
      <label className="provider-select-row">
        <span className="setting-title">Default model</span>
        <select
          className="provider-select"
          value={defaultId}
          onChange={(event) =>
            onChange({ defaultModel: event.target.value === "" ? undefined : event.target.value })
          }
        >
          <option value="">First in the list</option>
          {defaultListed ? null : <option value={defaultId}>{defaultId} (not listed)</option>}
          {listed.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <p className="setting-desc">New threads and the model picker start on this one.</p>
    </div>
  );
}
