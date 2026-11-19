import type { ProviderKind, RuntimeMode, Thread } from "@age/contracts";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { configureThread } from "../state/actions.ts";
import { NO_DISABLED_PROVIDERS, useStore } from "../state/store.ts";
import { IconCheckSmall, IconLock, IconPen, IconSearch, IconShield } from "./Icons.tsx";
import { useMinuteClock } from "./failover/clock.ts";
import {
  cooldownFor,
  limitedUntilLabel,
  sameTarget,
  targetLabel,
  targetOf,
} from "./failover/format.ts";
import { isAvailable, modelLabel, providerLabels, runtimeModes, shortcut } from "./labels.ts";
import { pickerModels } from "./providers/helpers.ts";

const modeMeta: Record<RuntimeMode, { icon: () => ReactNode; description: string }> = {
  approve: {
    icon: IconLock,
    description: "Ask before commands and file changes.",
  },
  "auto-edits": {
    icon: IconPen,
    description: "Auto-approve edits, ask before other actions.",
  },
  full: {
    icon: IconShield,
    description: "Allow commands and edits without prompts.",
  },
};

/** Chip that opens the T3-style permissions segmented control. */
export function PermissionsPickerButton({
  thread,
  className,
  children,
  placement = "above",
}: {
  thread: Thread;
  className: string;
  children: ReactNode;
  placement?: "below" | "above";
}) {
  return (
    <PopoverChip
      className={className}
      placement={placement}
      label="Permissions"
      title={`Permissions: ${runtimeModes.find((mode) => mode.id === thread.runtimeMode)?.label ?? "Permissions"}`}
      panel={<PermissionsPanel thread={thread} />}
    >
      {children}
    </PopoverChip>
  );
}

/** Chip that opens the Synara-style searchable model picker. */
export function ModelPickerButton({
  thread,
  className,
  children,
  placement = "above",
  open,
  onOpenChange,
}: {
  thread: Thread;
  className: string;
  children: ReactNode;
  placement?: "below" | "above";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <PopoverChip
      className={className}
      placement={placement}
      label="Model"
      title="Change provider or model"
      panel={<ProviderModelPanel thread={thread} />}
      wide
      open={open}
      onOpenChange={onOpenChange}
    >
      {children}
      <FallbackTag thread={thread} />
    </PopoverChip>
  );
}

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

function PopoverChip({
  className,
  children,
  placement,
  label,
  title,
  panel,
  wide = false,
  open: controlledOpen,
  onOpenChange,
}: {
  className: string;
  children: ReactNode;
  placement: "below" | "above";
  label: string;
  title: string;
  panel: ReactNode;
  wide?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const root = useRef<HTMLDivElement>(null);
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenState(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpenState]);

  return (
    <div className="popover-root" ref={root}>
      <button
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        title={title}
        onClick={() => setOpenState(!open)}
      >
        {children}
      </button>
      {open ? (
        <div
          className={wide ? `popover popover-wide ${placement}` : `popover ${placement}`}
          id={id}
          role="dialog"
          aria-label={label}
        >
          {panel}
        </div>
      ) : null}
    </div>
  );
}

function PermissionsPanel({ thread }: { thread: Thread }) {
  const running = thread.status === "running" || thread.status === "waiting";
  const [preview, setPreview] = useState<RuntimeMode | null>(null);
  const shown = preview ?? thread.runtimeMode;
  const shownMeta = modeMeta[shown];
  const shownLabel = runtimeModes.find((mode) => mode.id === shown)?.label ?? shown;

  return (
    <div className="permissions-panel">
      <p className="picker-heading">Permissions</p>
      <div
        className="permissions-toggle"
        role="radiogroup"
        aria-label="Permissions"
        aria-disabled={running || undefined}
      >
        {runtimeModes.map((mode) => {
          const Icon = modeMeta[mode.id].icon;
          const checked = mode.id === thread.runtimeMode;
          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={mode.label}
              className={checked ? "permissions-seg active" : "permissions-seg"}
              disabled={running}
              onMouseEnter={() => setPreview(mode.id)}
              onMouseLeave={() => setPreview(null)}
              onFocus={() => setPreview(mode.id)}
              onBlur={() => setPreview(null)}
              onClick={() => {
                if (mode.id !== thread.runtimeMode) {
                  void configureThread(thread.id, { runtimeMode: mode.id });
                }
              }}
            >
              <Icon />
            </button>
          );
        })}
      </div>
      <div className="permissions-copy" aria-live="polite">
        <p
          className={shown === thread.runtimeMode ? "permissions-title" : "permissions-title muted"}
        >
          {shownLabel}
        </p>
        <p className="permissions-desc">{shownMeta.description}</p>
      </div>
      {running ? <p className="picker-note">Settings change once the current turn ends.</p> : null}
    </div>
  );
}

function ProviderModelPanel({ thread }: { thread: Thread }) {
  const providers = useStore((state) => state.providers);
  const disabledProviders = useStore(
    (state) => state.deviceSettings?.disabledProviders ?? NO_DISABLED_PROVIDERS,
  );
  const disabled = useMemo(() => new Set(disabledProviders), [disabledProviders]);
  const deviceSettings = useStore((state) => state.deviceSettings);
  const cooldowns = useStore((state) => state.model.cooldowns);
  const nowMs = useMinuteClock();
  const running = thread.status === "running" || thread.status === "waiting";
  const [chosenTab, setTab] = useState<ProviderKind>(thread.provider);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // sync: focus search when the panel mounts
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const tab = providers.some((entry) => entry.kind === chosenTab) ? chosenTab : thread.provider;
  const active = providers.find((entry) => entry.kind === tab) ?? null;
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
    if (kind === thread.provider && modelId === thread.model) return;
    void configureThread(thread.id, { provider: kind, model: modelId });
  };

  // sync: ⌘1–9 / Ctrl+1–9 pick the visible model row
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const index = Number(event.key);
      if (!Number.isInteger(index) || index < 1 || index > 9) return;
      const model = models[index - 1];
      if (!model || !active || !isAvailable(active, disabled)) return;
      event.preventDefault();
      if (tab === thread.provider && model.id === thread.model) return;
      void configureThread(thread.id, { provider: tab, model: model.id });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [models, active, tab, thread.id, thread.provider, thread.model, disabled]);

  const summaryModel = modelLabel(providers, thread.provider, thread.model);
  const summaryMode =
    runtimeModes.find((mode) => mode.id === thread.runtimeMode)?.short ?? thread.runtimeMode;

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
              <span className={`provider-mark provider-${provider.kind}`} aria-hidden="true" />
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
            const selected = tab === thread.provider && model.id === thread.model;
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
                  disabled={running || (active ? !isAvailable(active, disabled) : true)}
                  onClick={() => pick(tab, model.id)}
                >
                  <span className={`provider-mark provider-${tab}`} aria-hidden="true" />
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
        <div className="model-mode-pills" role="group" aria-label="Runtime mode">
          {runtimeModes.map((mode) => {
            const Icon = modeMeta[mode.id].icon;
            const activeMode = mode.id === thread.runtimeMode;
            return (
              <button
                key={mode.id}
                type="button"
                className={activeMode ? "model-pill active" : "model-pill"}
                disabled={running}
                title={modeMeta[mode.id].description}
                onClick={() => {
                  if (mode.id !== thread.runtimeMode) {
                    void configureThread(thread.id, { runtimeMode: mode.id });
                  }
                }}
              >
                <Icon />
                <span>{mode.short}</span>
              </button>
            );
          })}
        </div>
        <div
          className="model-summary"
          title={`${providerLabels[thread.provider]} · ${summaryModel}`}
        >
          <span className={`provider-mark provider-${thread.provider}`} aria-hidden="true" />
          <span>
            {summaryModel} {summaryMode}
          </span>
        </div>
      </div>
    </div>
  );
}
