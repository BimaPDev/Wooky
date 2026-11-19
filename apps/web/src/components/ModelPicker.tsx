import type {
  EffortLevel,
  InteractionMode,
  ProviderKind,
  RuntimeMode,
  Thread,
} from "@age/contracts";
import { chipModelName, effortLabel, shownEffort } from "../lib/composer-model.ts";
import { useStore } from "../state/store.ts";
import { IconAlert, IconCheckSmall } from "./Icons.tsx";
import { sameTarget, targetLabel, targetOf } from "./failover/format.ts";
import { runtimeModes } from "./labels.ts";
import { ModelPanel, runtimeMeta } from "./ModelPanel.tsx";
import { moveFocus, PopoverChip, usePopoverClose } from "./Popover.tsx";
import { ProviderMark } from "./ProviderMark.tsx";

/** What the composer starts or continues a thread with. `isolate` is offered on the draft screen only. */
export interface PickerTarget {
  provider: ProviderKind;
  model: string;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** The effort picked, if any. The model's own default applies when absent. */
  effort: EffortLevel | undefined;
  fastMode?: boolean;
  ultracode?: boolean;
  isolate?: boolean;
}

export type PickerPatch = Partial<PickerTarget>;

/** Marks a thread that runs on a fallback model; the tooltip names the model it started on. */
function FallbackTag({ thread }: { thread: Thread }) {
  const providers = useStore((state) => state.providers);
  const original = thread.failover?.original;
  if (!original || sameTarget(original, targetOf(thread))) return null;
  return (
    <span className="fallback-tag" title={`Original: ${targetLabel(providers, original)}`}>
      Fallback
    </span>
  );
}

/**
 * The model chip: the provider's mark, the model's short name and, when it has one, the effort.
 * It opens the picker, which also holds effort, speed and the runtime options.
 */
export function ModelChip({
  target,
  onChange,
  locked,
  planSupported,
  failoverThread,
  open,
  onOpenChange,
}: {
  target: PickerTarget;
  onChange: (patch: PickerPatch) => void;
  locked: boolean;
  planSupported: boolean;
  failoverThread?: Thread;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const status = useStore((state) =>
    state.providers.find((entry) => entry.kind === target.provider),
  );
  const name = chipModelName(status, target.model);
  const effort = shownEffort(status, target.model, target.effort);
  return (
    <PopoverChip
      className="composer-model-chip"
      label="Model and options"
      title={`Model: ${name}${effort ? `, ${effortLabel(effort)} effort` : ""}`}
      size="picker"
      align="end"
      minRoom={480}
      open={open}
      onOpenChange={onOpenChange}
      panel={
        <ModelPanel
          target={target}
          onChange={onChange}
          locked={locked}
          planSupported={planSupported}
        />
      }
    >
      <ProviderMark kind={target.provider} />
      <span className="composer-model-name">{name}</span>
      {effort ? <span className="composer-model-effort">{effortLabel(effort)}</span> : null}
      {failoverThread ? <FallbackTag thread={failoverThread} /> : null}
    </PopoverChip>
  );
}

/** The small line under the composer: the runtime mode as icon and label, with a "Plan" tag when on. */
export function RuntimeIndicator({
  runtimeMode,
  interactionMode,
  locked,
  onChange,
}: {
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  locked: boolean;
  onChange: (patch: PickerPatch) => void;
}) {
  const meta = runtimeMeta[runtimeMode];
  const Icon = runtimeMode === "full" ? IconAlert : meta.icon;
  return (
    <div className="composer-runtime">
      {interactionMode === "plan" ? <span className="composer-plan-tag">Plan</span> : null}
      <PopoverChip
        className={runtimeMode === "full" ? "composer-runtime-btn warn" : "composer-runtime-btn"}
        label="Runtime mode"
        title={`Runtime mode: ${meta.label}`}
        size="small"
        align="end"
        panel={
          <RuntimeMenu
            runtimeMode={runtimeMode}
            locked={locked}
            onPick={(mode) => mode !== runtimeMode && onChange({ runtimeMode: mode })}
          />
        }
      >
        <Icon />
        <span>{meta.label}</span>
      </PopoverChip>
    </div>
  );
}

function RuntimeMenu({
  runtimeMode,
  locked,
  onPick,
}: {
  runtimeMode: RuntimeMode;
  locked: boolean;
  onPick: (mode: RuntimeMode) => void;
}) {
  const close = usePopoverClose();
  return (
    <div className="runtime-menu">
      <div role="radiogroup" aria-label="Runtime mode" onKeyDown={moveFocus}>
        {runtimeModes.map((mode) => {
          const meta = runtimeMeta[mode.id];
          const Icon = meta.icon;
          const checked = mode.id === runtimeMode;
          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={checked}
              className={checked ? "runtime-option active" : "runtime-option"}
              disabled={locked}
              autoFocus={checked}
              onClick={() => {
                onPick(mode.id);
                close();
              }}
            >
              <Icon />
              <span className="runtime-option-copy">
                <span className="runtime-option-title">{meta.label}</span>
                <span className="runtime-option-desc">{meta.description}</span>
              </span>
              {checked ? (
                <span className="runtime-option-check" aria-hidden="true">
                  <IconCheckSmall />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {locked ? <p className="picker-note">Settings change once the current turn ends.</p> : null}
    </div>
  );
}
