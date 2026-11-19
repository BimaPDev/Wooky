import type { ProviderKind, RuntimeMode } from "@wooky/contracts";
import { useMemo, useRef, useState } from "react";
import { closeFanoutDialog, startFanout } from "../../state/actions.ts";
import { NO_DISABLED_PROVIDERS, useStore } from "../../state/store.ts";
import { isAvailable, runtimeModes } from "../labels.ts";
import { Modal } from "../Modal.tsx";
import { defaultModelFor } from "../providers/helpers.ts";
import { FANOUT_MAX_TARGETS, FANOUT_MIN_TARGETS, fanoutTargetError } from "./helpers.ts";

interface TargetDraft {
  provider: ProviderKind;
  model: string;
}

export function FanoutDialog() {
  const dialog = useStore((state) => state.fanoutDialog);
  if (!dialog) return null;
  return <FanoutDialogBody dialog={dialog} />;
}

function FanoutDialogBody({
  dialog,
}: {
  dialog: { projectId: string; runtimeMode: RuntimeMode; getPrompt: () => string };
}) {
  const providers = useStore((state) => state.providers);
  const deviceSettings = useStore((state) => state.deviceSettings);
  const disabledProviders = useStore(
    (state) => state.deviceSettings?.disabledProviders ?? NO_DISABLED_PROVIDERS,
  );
  const disabled = useMemo(() => new Set(disabledProviders), [disabledProviders]);
  const available = useMemo(
    () => providers.filter((provider) => isAvailable(provider, disabled)),
    [providers, disabled],
  );
  const [targets, setTargets] = useState<TargetDraft[]>(() => defaultTargets(available));
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(dialog.runtimeMode);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const error = fanoutTargetError(targets);
  const canStart = error === null && !busy;

  const update = (index: number, patch: Partial<TargetDraft>) => {
    setTargets((current) =>
      current.map((target, i) => {
        if (i !== index) return target;
        const next = { ...target, ...patch };
        if (patch.provider && patch.provider !== target.provider) {
          next.model = defaultModelFor(
            available.find((entry) => entry.kind === patch.provider),
            deviceSettings,
          );
        }
        return next;
      }),
    );
  };

  return (
    <Modal label="Run on several agents" onClose={closeFanoutDialog}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canStart || submitting.current) return;
          submitting.current = true;
          setBusy(true);
          try {
            const prompt = dialog.getPrompt();
            if (!prompt) {
              useStore.setState({ notice: "The prompt is empty." });
              return;
            }
            await startFanout({
              projectId: dialog.projectId,
              prompt,
              targets,
              runtimeMode,
            });
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <h2 className="modal-title">Run on several agents</h2>
        <p className="modal-body">{dialog.getPrompt()}</p>
        <ol className="fleet-fanout-targets">
          {targets.map((target, index) => {
            const provider = available.find((entry) => entry.kind === target.provider);
            return (
              <li key={index} className="fleet-fanout-target">
                <label className="field">
                  <span>Agent {index + 1}</span>
                  <select
                    value={target.provider}
                    aria-label={`Provider for agent ${index + 1}`}
                    onChange={(event) =>
                      update(index, { provider: event.target.value as ProviderKind })
                    }
                  >
                    {available.map((entry) => (
                      <option key={entry.kind} value={entry.kind}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Model</span>
                  <select
                    value={target.model}
                    aria-label={`Model for agent ${index + 1}`}
                    onChange={(event) => update(index, { model: event.target.value })}
                  >
                    {(provider?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Remove agent ${index + 1}`}
                  disabled={targets.length <= FANOUT_MIN_TARGETS}
                  onClick={() => setTargets((current) => current.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
        <div className="fleet-fanout-add">
          <button
            type="button"
            className="button"
            disabled={targets.length >= FANOUT_MAX_TARGETS || available.length === 0}
            onClick={() => {
              const next = defaultTargets(available)[0];
              if (next) setTargets((current) => [...current, next]);
            }}
          >
            Add agent
          </button>
          <span className="muted">
            {targets.length} of {FANOUT_MAX_TARGETS}
          </span>
        </div>
        <label className="field">
          <span>Runtime mode</span>
          <select
            value={runtimeMode}
            onChange={(event) => setRuntimeMode(event.target.value as RuntimeMode)}
          >
            {runtimeModes.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="modal-body warn">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="button" onClick={closeFanoutDialog}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!canStart}>
            Start
          </button>
        </div>
      </form>
    </Modal>
  );
}

function defaultTargets(
  available: { kind: ProviderKind; models: { id: string }[] }[],
): TargetDraft[] {
  const pairs: TargetDraft[] = [];
  for (const provider of available) {
    for (const model of provider.models) {
      pairs.push({ provider: provider.kind, model: model.id });
      if (pairs.length === FANOUT_MIN_TARGETS) return pairs;
    }
  }
  while (pairs.length < FANOUT_MIN_TARGETS && pairs[0]) pairs.push({ ...pairs[0] });
  return pairs;
}
