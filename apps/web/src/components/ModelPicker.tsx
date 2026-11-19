import type {
  EffortLevel,
  InteractionMode,
  ProviderKind,
  RuntimeMode,
  Thread,
} from "@age/contracts";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { chipModelName, effortLabel, effortsFor, shownEffort } from "../lib/composer-model.ts";
import { NO_DISABLED_PROVIDERS, useStore } from "../state/store.ts";
import { IconAlert, IconCheckSmall, IconLock, IconPen, IconSearch, IconShield } from "./Icons.tsx";
import { useMinuteClock } from "./failover/clock.ts";
import {
  cooldownFor,
  limitedUntilLabel,
  sameTarget,
  targetLabel,
  targetOf,
} from "./failover/format.ts";
import { isAvailable, runtimeModes, shortcut } from "./labels.ts";
import { ProviderMark } from "./ProviderMark.tsx";
import { pickerModels } from "./providers/helpers.ts";

/** What the composer starts or continues a thread with. `isolate` is offered on the draft screen only. */
export interface PickerTarget {
  provider: ProviderKind;
  model: string;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** The effort picked, if any. The model's own default applies when absent. */
  effort: EffortLevel | undefined;
  isolate?: boolean;
}

export type PickerPatch = Partial<PickerTarget>;

const modeMeta: Record<RuntimeMode, { icon: () => ReactNode; label: string; description: string }> =
  {
    approve: {
      icon: IconLock,
      label: "Ask first",
      description: "Ask before commands and file changes.",
    },
    "auto-edits": {
      icon: IconPen,
      label: "Auto-accept edits",
      description: "Auto-approve edits, ask before other actions.",
    },
    full: {
      icon: IconShield,
      label: "Full access",
      description: "Allow commands and edits without prompts.",
    },
  };

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

const PopoverCloseContext = createContext<() => void>(() => {});

/** Closes the popover a panel sits in. */
export const usePopoverClose = () => useContext(PopoverCloseContext);

export function PopoverChip({
  className,
  children,
  placement = "above",
  align = "start",
  label,
  title,
  panel,
  size = "normal",
  open: controlledOpen,
  onOpenChange,
}: {
  className: string;
  children: ReactNode;
  placement?: "below" | "above";
  align?: "start" | "end";
  label: string;
  title: string;
  panel: ReactNode;
  size?: "small" | "normal" | "wide";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  const setOpenState = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  // sync: document-level pointer and key listeners close the popover
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenState(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenState(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpenState]);

  const close = useCallback(() => setOpenState(false), [setOpenState]);

  // sync: the popover's room above or below its trigger, so a tall panel shrinks its list
  useLayoutEffect(() => {
    const el = popover.current;
    const anchor = trigger.current;
    if (!open || !el || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const room = placement === "above" ? rect.top : window.innerHeight - rect.bottom;
    el.style.setProperty("--popover-room", `${Math.max(240, Math.floor(room - 64))}px`);
  }, [open, placement]);
  const popoverClass = [
    "popover",
    size === "wide" ? "popover-wide" : size === "small" ? "popover-small" : null,
    placement,
    align === "end" ? "end" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="popover-root" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setOpenState(!open)}
      >
        {children}
      </button>
      {open ? (
        <div ref={popover} className={popoverClass} id={id} role="dialog" aria-label={label}>
          <PopoverCloseContext value={close}>{panel}</PopoverCloseContext>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The model chip: the provider's mark, the model's short name and, when it has one, the effort.
 * It opens the picker, which also holds effort, plan mode, runtime mode and "Run on several agents".
 */
export function ModelChip({
  target,
  onChange,
  locked,
  planSupported,
  failoverThread,
  onFanout,
  fanoutDisabled,
  open,
  onOpenChange,
}: {
  target: PickerTarget;
  onChange: (patch: PickerPatch) => void;
  /** A turn is running: nothing can change until it ends. */
  locked: boolean;
  planSupported: boolean;
  failoverThread?: Thread;
  onFanout: () => void;
  fanoutDisabled: boolean;
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
      size="wide"
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      panel={
        <ProviderModelPanel
          target={target}
          onChange={onChange}
          locked={locked}
          planSupported={planSupported}
          onFanout={onFanout}
          fanoutDisabled={fanoutDisabled}
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
  const meta = modeMeta[runtimeMode];
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

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(index + step + items.length) % items.length]?.focus();
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
          const meta = modeMeta[mode.id];
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

function Switch({
  label,
  hint,
  checked,
  disabled,
  title,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="picker-switch"
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="picker-switch-copy">
        <span>{label}</span>
        {hint ? <span className="picker-switch-hint">{hint}</span> : null}
      </span>
      <span className="picker-switch-track" data-on={checked} aria-hidden="true">
        <span className="picker-switch-thumb" />
      </span>
    </button>
  );
}

function ProviderModelPanel({
  target,
  onChange,
  locked,
  planSupported,
  onFanout,
  fanoutDisabled,
}: {
  target: PickerTarget;
  onChange: (patch: PickerPatch) => void;
  locked: boolean;
  planSupported: boolean;
  onFanout: () => void;
  fanoutDisabled: boolean;
}) {
  const providers = useStore((state) => state.providers);
  const disabledProviders = useStore(
    (state) => state.deviceSettings?.disabledProviders ?? NO_DISABLED_PROVIDERS,
  );
  const disabled = useMemo(() => new Set(disabledProviders), [disabledProviders]);
  const deviceSettings = useStore((state) => state.deviceSettings);
  const cooldowns = useStore((state) => state.model.cooldowns);
  const nowMs = useMinuteClock();
  const close = usePopoverClose();
  const [chosenTab, setTab] = useState<ProviderKind>(target.provider);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // sync: focus search when the panel mounts
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const tab = providers.some((entry) => entry.kind === chosenTab) ? chosenTab : target.provider;
  const active = providers.find((entry) => entry.kind === tab) ?? null;
  const current = providers.find((entry) => entry.kind === target.provider);
  const needle = query.trim().toLowerCase();
  const models = useMemo(() => {
    const list = pickerModels(active ?? undefined, deviceSettings);
    if (!needle) return list;
    return list.filter(
      (model) =>
        model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
    );
  }, [active, deviceSettings, needle]);

  const pick = (kind: ProviderKind, modelId: string) => {
    if (kind === target.provider && modelId === target.model) return;
    const status = providers.find((entry) => entry.kind === kind);
    const effort = shownEffort(status, modelId, target.effort);
    onChange({ provider: kind, model: modelId, effort });
  };

  const pickByShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || locked) return;
    const index = Number(event.key);
    if (!Number.isInteger(index) || index < 1 || index > 9) return;
    const model = models[index - 1];
    if (!model || !active || !isAvailable(active, disabled)) return;
    event.preventDefault();
    pick(tab, model.id);
  });

  // sync: ⌘1–9 / Ctrl+1–9 pick the visible model row
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => pickByShortcut(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const efforts = effortsFor(current, target.model);
  const effort = shownEffort(current, target.model, target.effort);

  return (
    <div className="model-panel synara">
      <label className="model-search">
        <IconSearch />
        <input
          ref={searchRef}
          value={query}
          placeholder="Search models…"
          aria-label="Search models"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="model-tabs" role="tablist" aria-label="Providers">
        {providers.map((provider) => {
          const enabled = !disabled.has(provider.kind);
          const available = isAvailable(provider, disabled);
          const activeTab = provider.kind === tab;
          return (
            <button
              key={provider.kind}
              type="button"
              role="tab"
              aria-selected={activeTab}
              aria-label={provider.label}
              title={
                !enabled
                  ? `${provider.label} is disabled in Settings`
                  : (provider.problem ?? provider.label)
              }
              className={
                activeTab ? "model-tab active" : available ? "model-tab" : "model-tab disabled"
              }
              disabled={(!available && !activeTab) || !enabled}
              onClick={() => setTab(provider.kind)}
            >
              <ProviderMark kind={provider.kind} />
            </button>
          );
        })}
      </div>

      <div
        className="model-list"
        role="listbox"
        aria-label={`${active?.label ?? "Provider"} models`}
      >
        {!active ? (
          <p className="model-empty">No providers available.</p>
        ) : models.length === 0 ? (
          <p className="model-empty">{needle ? "No matching models." : "No models reported."}</p>
        ) : (
          models.map((model, index) => {
            const selected = tab === target.provider && model.id === target.model;
            const hint = index < 9 ? shortcut(String(index + 1)) : null;
            const cooldown = cooldowns
              ? cooldownFor(cooldowns, { provider: tab, model: model.id }, nowMs)
              : null;
            const heading = model.group && model.group !== models[index - 1]?.group;
            return (
              <Fragment key={model.id}>
                {heading ? (
                  <p className="model-group-heading" role="presentation">
                    {model.group}
                  </p>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={selected ? "model-row selected" : "model-row"}
                  disabled={locked || (active ? !isAvailable(active, disabled) : true)}
                  onClick={() => pick(tab, model.id)}
                >
                  <ProviderMark kind={tab} />
                  <span className="model-row-copy">
                    <span className="model-row-title">{model.label}</span>
                    {model.isDefault ? <span className="model-row-note">Default</span> : null}
                    {cooldown ? (
                      <span className="model-row-note">
                        {limitedUntilLabel(cooldown.until, nowMs)}
                      </span>
                    ) : null}
                  </span>
                  {selected ? (
                    <span className="model-row-check" aria-hidden="true">
                      <IconCheckSmall />
                    </span>
                  ) : (
                    <span className="model-row-spacer" aria-hidden="true" />
                  )}
                  {hint ? <kbd className="model-kbd">{hint}</kbd> : null}
                </button>
              </Fragment>
            );
          })
        )}
      </div>

      <div className="model-footer">
        {efforts.length > 0 ? (
          <div className="picker-row">
            <span className="picker-row-label" id="picker-effort-label">
              Effort
            </span>
            <div
              className="picker-segments"
              role="radiogroup"
              aria-labelledby="picker-effort-label"
            >
              {efforts.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={level === effort}
                  className={level === effort ? "picker-segment active" : "picker-segment"}
                  disabled={locked}
                  onClick={() => level !== effort && onChange({ effort: level })}
                >
                  {effortLabel(level)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <Switch
          label="Plan first"
          checked={target.interactionMode === "plan"}
          disabled={locked || !planSupported}
          title={planSupported ? undefined : "This provider does not support plan mode"}
          onChange={(next) => onChange({ interactionMode: next ? "plan" : "default" })}
        />
        <div className="picker-row">
          <span className="picker-row-label" id="picker-runtime-label">
            Runtime
          </span>
          <div className="picker-segments" role="radiogroup" aria-labelledby="picker-runtime-label">
            {runtimeModes.map((mode) => {
              const activeMode = mode.id === target.runtimeMode;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={activeMode}
                  className={activeMode ? "picker-segment active" : "picker-segment"}
                  disabled={locked}
                  title={modeMeta[mode.id].description}
                  onClick={() => !activeMode && onChange({ runtimeMode: mode.id })}
                >
                  {mode.short}
                </button>
              );
            })}
          </div>
        </div>
        {target.isolate !== undefined ? (
          <Switch
            label="New worktree"
            title="Work on its own branch and checkout"
            checked={target.isolate}
            onChange={(next) => onChange({ isolate: next })}
          />
        ) : null}
        <button
          type="button"
          className="picker-action"
          disabled={fanoutDisabled}
          title={fanoutDisabled ? "Type a message first" : undefined}
          onClick={() => {
            close();
            onFanout();
          }}
        >
          Run on several agents
        </button>
        {locked ? <p className="picker-note">Settings change once the current turn ends.</p> : null}
      </div>
    </div>
  );
}
