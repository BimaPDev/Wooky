import type { ProviderKind, RuntimeMode } from "@age/contracts";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  effortLabel,
  effortsFor,
  favoriteRows,
  isFavoriteModel,
  modelHasFlag,
  pickerProviders,
  PROVIDER_SHORT_NAMES,
  providerRows,
  shownEffort,
  toggleFavoriteModel,
  type PickerRow,
} from "../lib/composer-model.ts";
import { setFavoriteModels } from "../state/actions.ts";
import { NO_DISABLED_PROVIDERS, useStore } from "../state/store.ts";
import {
  IconBolt,
  IconCheckSmall,
  IconChevron,
  IconLock,
  IconPen,
  IconSearch,
  IconShield,
  IconSparkles,
  IconStar,
} from "./Icons.tsx";
import { useMinuteClock } from "./failover/clock.ts";
import { cooldownFor, limitedUntilLabel } from "./failover/format.ts";
import { isAvailable, runtimeModes, shortcut } from "./labels.ts";
import { moveFocus, Segmented, Switch } from "./Popover.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import type { PickerPatch, PickerTarget } from "./ModelPicker.tsx";

type TabKey = "favorites" | ProviderKind;

const NO_FAVORITES: never[] = [];

export const runtimeMeta: Record<
  RuntimeMode,
  { icon: () => ReactNode; label: string; description: string }
> = {
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

/** The picker: search, provider tabs, the model list, then effort, speed and runtime options. */
export function ModelPanel({
  target,
  onChange,
  locked,
  planSupported,
}: {
  target: PickerTarget;
  onChange: (patch: PickerPatch) => void;
  /** A turn is running: nothing can change until it ends. */
  locked: boolean;
  planSupported: boolean;
}) {
  const providers = useStore((state) => state.providers);
  const deviceSettings = useStore((state) => state.deviceSettings);
  const favorites = useStore((state) => state.deviceSettings?.favoriteModels ?? NO_FAVORITES);
  const disabledProviders = useStore(
    (state) => state.deviceSettings?.disabledProviders ?? NO_DISABLED_PROVIDERS,
  );
  const disabled = useMemo(() => new Set(disabledProviders), [disabledProviders]);
  const cooldowns = useStore((state) => state.model.cooldowns);
  const fixture = useStore((state) => state.fixture);
  const nowMs = useMinuteClock();
  const [chosenTab, setTab] = useState<TabKey>(
    favorites.length > 0 ? "favorites" : target.provider,
  );
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // sync: focus the search field when the panel opens
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const visible = useMemo(
    () =>
      pickerProviders(providers, disabled, deviceSettings, {
        showDemo: fixture || import.meta.env.DEV,
        current: target.provider,
      }),
    [providers, disabled, deviceSettings, fixture, target.provider],
  );
  const tab: TabKey =
    chosenTab === "favorites" || visible.some((entry) => entry.kind === chosenTab)
      ? chosenTab
      : target.provider;
  const active = tab === "favorites" ? null : (visible.find((entry) => entry.kind === tab) ?? null);

  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const all =
      tab === "favorites"
        ? favoriteRows(favorites, visible, deviceSettings)
        : active
          ? providerRows(active, deviceSettings)
          : [];
    if (!needle) return all;
    return all.filter(
      (row) => row.label.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle),
    );
  }, [tab, favorites, visible, active, deviceSettings, needle]);

  const current = providers.find((entry) => entry.kind === target.provider);

  const pick = (row: PickerRow) => {
    if (locked || (row.provider === target.provider && row.id === target.model)) return;
    const status = providers.find((entry) => entry.kind === row.provider);
    onChange({
      provider: row.provider,
      model: row.id,
      effort: shownEffort(status, row.id, target.effort),
      ...(target.fastMode && !modelHasFlag(status, row.id, "fastMode") ? { fastMode: false } : {}),
      ...(target.ultracode && !modelHasFlag(status, row.id, "ultracode")
        ? { ultracode: false }
        : {}),
    });
  };

  const pickByShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const index = Number(event.key);
    if (!Number.isInteger(index) || index < 1 || index > 9) return;
    const row = rows[index - 1];
    if (!row) return;
    event.preventDefault();
    pick(row);
  });

  // sync: ⌘1–9 / Ctrl+1–9 pick the visible model row
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => pickByShortcut(event);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "favorites", label: "Favorites" },
    ...visible.map((entry) => ({ key: entry.kind as TabKey, label: entry.label })),
  ];

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = tabs.findIndex((entry) => entry.key === tab);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (!next) return;
    setTab(next.key);
    const group = event.currentTarget;
    requestAnimationFrame(() =>
      group.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(),
    );
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const focused = document.activeElement as HTMLElement | null;
    const isStar = focused?.classList.contains("pk-star") === true;
    if (event.key === "ArrowRight" && !isStar) {
      const star = focused?.parentElement?.querySelector<HTMLButtonElement>(".pk-star");
      if (star) {
        event.preventDefault();
        star.focus();
      }
      return;
    }
    if (event.key === "ArrowLeft" && isStar) {
      event.preventDefault();
      focused?.parentElement?.querySelector<HTMLButtonElement>(".pk-row-main")?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const mains = [
        ...(listRef.current?.querySelectorAll<HTMLButtonElement>(".pk-row-main") ?? []),
      ];
      const own = focused?.closest(".pk-row")?.querySelector<HTMLButtonElement>(".pk-row-main");
      const index = own ? mains.indexOf(own) : -1;
      if (index < 0) return;
      event.preventDefault();
      const next = mains[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) next.focus();
      else if (event.key === "ArrowUp") searchRef.current?.focus();
    }
  };

  const efforts = effortsFor(current, target.model);
  const effort = shownEffort(current, target.model, target.effort);
  const hasFast = modelHasFlag(current, target.model, "fastMode");
  const hasUltra = modelHasFlag(current, target.model, "ultracode");
  const firstSelectable = rows.findIndex(
    (row) => row.provider === target.provider && row.id === target.model,
  );

  return (
    <div className="pk-panel">
      <label className="pk-search">
        <IconSearch />
        <input
          ref={searchRef}
          value={query}
          placeholder="Search models..."
          aria-label="Search models"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>(".pk-row-main")?.focus();
            } else if (event.key === "Enter" && rows[0]) {
              event.preventDefault();
              pick(rows[0]);
            }
          }}
        />
      </label>

      <div className="pk-tabs" role="tablist" aria-label="Providers" onKeyDown={onTabKeyDown}>
        {tabs.map((entry) => {
          const selected = entry.key === tab;
          const name =
            entry.key === "favorites"
              ? "Favorites"
              : PROVIDER_SHORT_NAMES[entry.key as ProviderKind];
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={entry.label}
              title={name}
              tabIndex={selected ? 0 : -1}
              className={selected ? "pk-tab active" : "pk-tab"}
              onClick={() => setTab(entry.key)}
            >
              {entry.key === "favorites" ? (
                <IconStar filled={selected} />
              ) : (
                <ProviderMark kind={entry.key} size={24} />
              )}
            </button>
          );
        })}
      </div>

      <div
        ref={listRef}
        className="pk-list"
        role="listbox"
        aria-label={
          tab === "favorites" ? "Favorite models" : `${active?.label ?? "Provider"} models`
        }
        onKeyDown={onListKeyDown}
      >
        {rows.length === 0 ? (
          <p className="pk-empty">
            {needle
              ? "No matching models."
              : tab === "favorites"
                ? "Star a model to keep it here."
                : "No models reported."}
          </p>
        ) : (
          rows.map((row, index) => {
            const selected = row.provider === target.provider && row.id === target.model;
            const starred = isFavoriteModel(favorites, row.provider, row.id);
            const status = providers.find((entry) => entry.kind === row.provider);
            const cooldown = cooldowns
              ? cooldownFor(cooldowns, { provider: row.provider, model: row.id }, nowMs)
              : null;
            const rowDisabled = locked || (status ? !isAvailable(status, disabled) : true);
            const stop = firstSelectable < 0 ? index === 0 : index === firstSelectable;
            return (
              <div key={`${row.provider}:${row.id}`} className="pk-row" role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={stop ? 0 : -1}
                  className={selected ? "pk-row-main selected" : "pk-row-main"}
                  disabled={rowDisabled}
                  onClick={() => pick(row)}
                >
                  <ProviderMark kind={row.provider} size={18} />
                  <span className="pk-row-name">{row.label}</span>
                  {row.isDefault ? <span className="pk-row-note">Default</span> : null}
                  {cooldown ? (
                    <span className="pk-row-note">{limitedUntilLabel(cooldown.until, nowMs)}</span>
                  ) : null}
                  {selected ? (
                    <span className="pk-row-check" aria-hidden="true">
                      <IconCheckSmall />
                    </span>
                  ) : null}
                  {index < 9 ? <kbd className="pk-kbd">{shortcut(String(index + 1))}</kbd> : null}
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  className={starred ? "pk-star on" : "pk-star"}
                  aria-pressed={starred}
                  aria-label={`${starred ? "Remove" : "Add"} ${row.label} ${starred ? "from" : "to"} favorites`}
                  title={starred ? "Remove from favorites" : "Add to favorites"}
                  onClick={() =>
                    void setFavoriteModels(
                      toggleFavoriteModel(favorites, { provider: row.provider, model: row.id }),
                    )
                  }
                >
                  <IconStar filled={starred} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {efforts.length > 0 ? (
        <div className="pk-section">
          <Segmented
            label="Effort"
            className="pk-effort"
            options={efforts.map((level) => ({ id: level, label: effortLabel(level) }))}
            value={effort}
            disabled={locked}
            onChange={(level) => onChange({ effort: level })}
          />
        </div>
      ) : null}

      <div className="pk-section pk-bottom">
        {hasFast ? (
          <Segmented
            label="Speed"
            options={[
              { id: "standard", label: "Standard" },
              { id: "fast", label: "Fast", icon: <IconBolt /> },
            ]}
            value={target.fastMode ? "fast" : "standard"}
            disabled={locked}
            onChange={(speed) => onChange({ fastMode: speed === "fast" })}
          />
        ) : null}
        {hasUltra ? (
          <button
            type="button"
            role="switch"
            aria-checked={target.ultracode === true}
            className={target.ultracode ? "pk-chip on" : "pk-chip"}
            disabled={locked}
            title="Standing workflow orchestration at any effort level"
            onClick={() => onChange({ ultracode: !target.ultracode })}
          >
            <IconSparkles />
            <span>Ultracode</span>
          </button>
        ) : null}
        <RuntimeDropdown
          target={target}
          locked={locked}
          planSupported={planSupported}
          onChange={onChange}
        />
      </div>
      {locked ? <p className="pk-note">Settings change once the current turn ends.</p> : null}
    </div>
  );
}

function RuntimeDropdown({
  target,
  locked,
  planSupported,
  onChange,
}: {
  target: PickerTarget;
  locked: boolean;
  planSupported: boolean;
  onChange: (patch: PickerPatch) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const meta = runtimeMeta[target.runtimeMode];
  const Icon = meta.icon;

  // sync: a click outside the runtime menu closes it
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  return (
    <div className="pk-runtime" ref={root}>
      <button
        ref={button}
        type="button"
        className="pk-runtime-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen(!open)}
      >
        <Icon />
        <span>{meta.label}</span>
        <span className="pk-caret" data-open={open} aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open ? (
        <div
          className="pk-runtime-menu"
          role="menu"
          aria-label="Runtime options"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              button.current?.focus();
              return;
            }
            moveFocus(event);
          }}
        >
          <div role="radiogroup" aria-label="Runtime mode">
            {runtimeModes.map((mode) => {
              const option = runtimeMeta[mode.id];
              const OptionIcon = option.icon;
              const checked = mode.id === target.runtimeMode;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  autoFocus={checked}
                  className={checked ? "pk-menu-item active" : "pk-menu-item"}
                  title={option.description}
                  onClick={() => {
                    if (!checked) onChange({ runtimeMode: mode.id });
                    setOpen(false);
                    button.current?.focus();
                  }}
                >
                  <OptionIcon />
                  <span>{option.label}</span>
                  {checked ? (
                    <span className="pk-row-check" aria-hidden="true">
                      <IconCheckSmall />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <hr className="pk-rule" />
          <Switch
            label="Plan first"
            checked={target.interactionMode === "plan"}
            disabled={!planSupported}
            title={planSupported ? undefined : "This provider does not support plan mode"}
            onChange={(next) => onChange({ interactionMode: next ? "plan" : "default" })}
          />
          {target.isolate !== undefined ? (
            <Switch
              label="New worktree"
              title="Work on its own branch and checkout"
              checked={target.isolate}
              onChange={(next) => onChange({ isolate: next })}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
