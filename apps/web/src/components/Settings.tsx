import { DeviceSettings, type ProviderKind, type ProviderStatus } from "@age/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadDeviceSettings, patchDeviceSettings } from "../state/appearance.ts";
import {
  closeSettings,
  connectProvider,
  refreshProviders,
  setSettingsPage,
  signInCommand,
} from "../state/actions.ts";
import { useStore, type SettingsPage } from "../state/store.ts";
import { AppearanceSettings } from "./AppearanceSettings.tsx";
import {
  IconBot,
  IconChart,
  IconClose,
  IconFolder,
  IconInfo,
  IconPalette,
  IconRefresh,
  IconRestore,
  IconSearch,
  IconSliders,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { UsageDashboard } from "./UsageDashboard.tsx";

const NAV: { id: SettingsPage; label: string; group: string | null; icon: () => ReactNode }[] = [
  { id: "general", label: "General", group: null, icon: IconSliders },
  { id: "appearance", label: "Appearance", group: null, icon: IconPalette },
  { id: "usage", label: "Usage", group: null, icon: IconChart },
  { id: "providers", label: "Providers", group: "Agents", icon: IconBot },
  { id: "projects", label: "Projects", group: "Code", icon: IconFolder },
  { id: "about", label: "About", group: "About", icon: IconInfo },
];

export function Settings() {
  const page = useStore((state) => state.settingsPage);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  // sync: Escape closes settings, "/" focuses the settings search
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement;
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) closeSettings();
      else if (event.key === "/" && !typing) {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needle = query.trim().toLowerCase();
  const items = needle ? NAV.filter((item) => item.label.toLowerCase().includes(needle)) : NAV;

  // T3 opens Usage as its own modal route, not a settings section.
  if (page === "usage") return <UsageDashboard />;

  // T3 AppRouteModal: Settings floats over the app like Usage.
  return (
    <Modal label="Settings" onClose={closeSettings} className="modal app-route-modal">
      <div className="settings-shell">
        <aside className="settings-nav" aria-label="Settings sections">
          <label className="search-field">
            <IconSearch />
            <input
              ref={search}
              value={query}
              placeholder="Search"
              aria-label="Search settings"
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>/</kbd>
          </label>
          {groupNav(items).map(([group, list]) => (
            <div key={group ?? "app"} className="settings-nav-group">
              {group ? <p className="settings-nav-label">{group}</p> : null}
              {list.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={page === item.id ? "settings-nav-item active" : "settings-nav-item"}
                  aria-current={page === item.id ? "page" : undefined}
                  onClick={() => setSettingsPage(item.id)}
                >
                  <item.icon />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          {items.length === 0 ? <p className="sidebar-empty">No matching settings.</p> : null}
        </aside>
        <div className="settings-main">
          <header className="settings-head">
            <h2>
              <span className="muted">Settings</span>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              {labelFor(page)}
            </h2>
            <div className="settings-head-actions">
              {page === "general" ? (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void patchDeviceSettings(generalDefaults())}
                >
                  <IconRestore />
                  Restore device defaults
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button"
                aria-label="Close settings"
                title="Close (Esc)"
                onClick={closeSettings}
              >
                <IconClose />
              </button>
            </div>
          </header>
          <div className="settings-scroll" data-settings-page-scroll="">
            <div className="settings-content">
              {page === "general" ? <GeneralPage /> : null}
              {page === "appearance" ? <AppearanceSettings /> : null}
              {page === "providers" ? <ProvidersPage /> : null}
              {page === "projects" ? <ProjectsPage /> : null}
              {page === "about" ? <AboutPage /> : null}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function generalDefaults() {
  const {
    activeThemeId: _theme,
    colorMode: _mode,
    appearanceContrast: _contrast,
    glassOpacity: _glass,
    chatWidth: _width,
    ...rest
  } = DeviceSettings.parse({});
  return rest;
}

function groupNav(items: typeof NAV) {
  const map = new Map<string | null, typeof NAV>();
  for (const item of items) {
    const list = map.get(item.group) ?? [];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map.entries()];
}

function labelFor(page: SettingsPage) {
  return NAV.find((item) => item.id === page)?.label ?? page;
}

function GeneralPage() {
  const settings = useStore((state) => state.deviceSettings);
  // sync: load device settings when the general page mounts
  useEffect(() => {
    void loadDeviceSettings();
  }, []);

  if (!settings) return <p className="empty-state small">Loading settings.</p>;

  return (
    <div className="settings-sections">
      <SettingsSection title="Composer">
        <SettingRow
          title="Queue messages sent while the agent works"
          description="When on, new messages wait in a queue until the current turn finishes."
        >
          <Toggle
            checked={settings.followUp === "queue"}
            onChange={(checked) =>
              void patchDeviceSettings({ followUp: checked ? "queue" : "off" })
            }
            label="Queue messages sent while the agent works"
          />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Sidebar">
        <SettingRow
          title="Project grouping"
          description="Group threads under their project in the sidebar."
        >
          <Toggle
            checked={settings.projectGrouping}
            onChange={(checked) => void patchDeviceSettings({ projectGrouping: checked })}
            label="Project grouping"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

function ProvidersPage() {
  const providers = useStore((state) => state.providers);
  const settings = useStore((state) => state.deviceSettings);
  const [chosen, setSelected] = useState<ProviderKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // sync: load device settings for provider enable toggles
  useEffect(() => {
    void loadDeviceSettings();
  }, []);

  const selected =
    chosen && providers.some((entry) => entry.kind === chosen)
      ? chosen
      : (providers[0]?.kind ?? null);
  const disabled = new Set(settings?.disabledProviders ?? []);
  const active = providers.find((entry) => entry.kind === selected) ?? null;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshProviders();
    } finally {
      setRefreshing(false);
    }
  };

  const setEnabled = (kind: ProviderKind, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) next.delete(kind);
    else next.add(kind);
    void patchDeviceSettings({ disabledProviders: [...next] });
  };

  return (
    <div className="settings-sections">
      <SettingsSection
        title="Providers"
        action={
          <button
            type="button"
            className="ghost-button"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={() => void onRefresh()}
          >
            <IconRefresh />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        }
      >
        {providers.length === 0 ? (
          <p className="settings-help">No providers reported yet. Refresh to probe your PATH.</p>
        ) : (
          <div className="providers-panel">
            <div className="providers-list" role="listbox" aria-label="Providers">
              {providers.map((provider) => {
                const enabled = !disabled.has(provider.kind);
                const summary = providerSummary(provider, enabled);
                const isSelected = provider.kind === selected;
                return (
                  <div
                    key={provider.kind}
                    role="option"
                    aria-selected={isSelected}
                    className={
                      isSelected
                        ? "provider-row selected"
                        : enabled
                          ? "provider-row"
                          : "provider-row disabled"
                    }
                  >
                    <button
                      type="button"
                      className="provider-row-hit"
                      aria-label={`Select ${provider.label}`}
                      onClick={() => setSelected(provider.kind)}
                    />
                    <ProviderMark kind={provider.kind} />
                    <span className="provider-row-copy">
                      <span className="provider-row-title">
                        <span className="provider-row-name">{provider.label}</span>
                        {provider.version ? (
                          <code className="provider-row-version">v{provider.version}</code>
                        ) : null}
                      </span>
                      <span
                        className={
                          summary.tone === "error"
                            ? "provider-row-status error"
                            : "provider-row-status"
                        }
                      >
                        {summary.tone === "error" ? (
                          <span className="provider-status-dot" aria-hidden />
                        ) : null}
                        <span>
                          {summary.headline}
                          {summary.detail ? ` · ${summary.detail}` : ""}
                        </span>
                      </span>
                    </span>
                    <span className="provider-row-actions">
                      <Toggle
                        checked={enabled}
                        onChange={(checked) => setEnabled(provider.kind, checked)}
                        label={`Enable ${provider.label}`}
                      />
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="provider-detail" data-provider-detail="">
              {active ? (
                <ProviderDetail
                  provider={active}
                  enabled={!disabled.has(active.kind)}
                  onEnabledChange={(checked) => setEnabled(active.kind, checked)}
                />
              ) : (
                <p className="muted">No providers configured.</p>
              )}
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

function ProviderDetail({
  provider,
  enabled,
  onEnabledChange,
}: {
  provider: ProviderStatus;
  enabled: boolean;
  onEnabledChange: (checked: boolean) => void;
}) {
  const summary = providerSummary(provider, enabled);
  const login = signInCommand(provider.kind);
  const needsSignIn =
    provider.kind !== "demo" &&
    (provider.authenticated === false || (!provider.installed && Boolean(login)));
  const connected =
    enabled && provider.installed && provider.authenticated !== false && !provider.problem;

  return (
    <div className="provider-detail-inner">
      <header className="provider-detail-head">
        <div className="provider-detail-title">
          <ProviderMark kind={provider.kind} />
          <h4>{provider.label}</h4>
        </div>
        <div className="provider-detail-head-actions">
          {provider.version ? (
            <code className="provider-row-version">v{provider.version}</code>
          ) : null}
          <Toggle checked={enabled} onChange={onEnabledChange} label={`Enable ${provider.label}`} />
        </div>
      </header>

      <div className="provider-detail-block">
        <p className="setting-title">Status</p>
        <p
          className={
            summary.tone === "error" ? "provider-detail-status error" : "provider-detail-status"
          }
        >
          {summary.headline}
          {summary.detail ? ` · ${summary.detail}` : ""}
        </p>
        {login ? (
          <div className="provider-connect-row">
            <button
              type="button"
              className={needsSignIn || !connected ? "button primary" : "ghost-button"}
              onClick={() => connectProvider(provider.kind)}
            >
              {needsSignIn || !connected ? "Sign in" : "Sign in again"}
            </button>
            <p className="setting-desc">
              Opens the terminal and runs <code className="mono">{login}</code>.
            </p>
          </div>
        ) : (
          <p className="setting-desc">Built in. No sign-in needed.</p>
        )}
      </div>

      <div className="provider-detail-block">
        <p className="setting-title">Display name</p>
        <p className="setting-desc">Shown in the sidebar and composer for this provider.</p>
        <div className="provider-display-row">
          <span className={`provider-accent provider-${provider.kind}`} aria-hidden />
          <input
            className="provider-display-input"
            value={provider.label}
            readOnly
            aria-label="Display name"
          />
        </div>
      </div>

      <div className="provider-detail-runtime">
        <h5>Runtime</h5>
        <SettingRow
          title="Binary"
          description="Wooky drives the CLI on your PATH. Install it, sign in, then refresh."
        >
          <code className="mono muted">{binaryHint(provider.kind)}</code>
        </SettingRow>
        <SettingRow
          title="Models"
          description={
            provider.models.length > 0
              ? "Models reported by this provider."
              : "No models reported yet."
          }
        >
          {provider.models.length > 0 ? (
            <ul className="provider-model-list">
              {provider.models.map((model) => (
                <li key={model.id}>{model.label}</li>
              ))}
            </ul>
          ) : (
            <span className="muted">—</span>
          )}
        </SettingRow>
      </div>
    </div>
  );
}

function ProviderMark({ kind }: { kind: ProviderKind }) {
  return (
    <span className={`provider-mark provider-${kind}`} aria-hidden>
      {kind.slice(0, 1).toUpperCase()}
    </span>
  );
}

function providerSummary(provider: ProviderStatus, enabled: boolean) {
  if (!enabled)
    return { headline: "Disabled", detail: null as string | null, tone: "muted" as const };
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.problem,
      tone: "error" as const,
    };
  }
  if (provider.problem) {
    return { headline: "Error", detail: provider.problem, tone: "error" as const };
  }
  if (provider.authenticated === false) {
    return { headline: "Signed out", detail: null, tone: "muted" as const };
  }
  if (provider.authenticated === true) {
    return { headline: "Authenticated", detail: null, tone: "ok" as const };
  }
  return { headline: "Installed", detail: null, tone: "ok" as const };
}

function binaryHint(kind: ProviderKind) {
  switch (kind) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "cursor":
      return "agent";
    case "demo":
      return "built-in";
  }
}

function ProjectsPage() {
  const projects = useStore((state) => state.model.projects);
  const list = Object.values(projects);
  return (
    <SettingsSection title="Projects">
      {list.length === 0 ? (
        <p className="muted">No projects yet. Use Add project in the sidebar.</p>
      ) : (
        <ul className="settings-plain-list">
          {list.map((project) => (
            <li key={project.id}>
              <strong>{project.name}</strong>
              <span className="mono muted">{project.root}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function AboutPage() {
  return (
    <SettingsSection title="Wooky">
      <p>
        Local-first workspace for coding agents. Appearance themes are JSON files under{" "}
        <code className="mono">AGE_HOME/themes</code> so you or an agent can edit them.
      </p>
    </SettingsSection>
  );
}

function SettingsSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">{title}</p>
        <p className="setting-desc">{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "toggle on" : "toggle"}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}
