import {
  DeviceSettings,
  type AcpAgentConfig,
  type ProviderKind,
  type ProviderSettings,
  type ProviderStatus,
} from "@wooky/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadDeviceSettings, patchDeviceSettings } from "../state/appearance.ts";
import {
  closeSettings,
  connectProvider,
  refreshProviders,
  setSettingsPage,
} from "../state/actions.ts";
import { useStore, type SettingsPage } from "../state/store.ts";
import { AppearanceSettings } from "./AppearanceSettings.tsx";
import { NotificationSettings } from "./anywhere/notifications/NotificationSettings.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { FailoverSettings } from "./FailoverSettings.tsx";
import {
  IconBot,
  IconChart,
  IconCircleArrowUp,
  IconClose,
  IconFolder,
  IconInfo,
  IconPalette,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconSearch,
  IconSliders,
} from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { AgentEditor, AgentPresets } from "./providers/AcpAgents.tsx";
import { agentFromPreset, LIMITS, updateProviderSettings } from "./providers/helpers.ts";
import { ProviderSettingsPanel } from "./providers/ProviderSettingsPanel.tsx";
import { useSettingsDraft } from "./providers/useSettingsDraft.ts";
import { AnywhereSettings } from "./anywhere/settings/AnywhereSettings.tsx";
import { IconAnywhere } from "./anywhere/settings/controls.tsx";
import { UsageDashboard } from "./UsageDashboard.tsx";
import { ProviderMark } from "./ProviderMark.tsx";

const NAV: { id: SettingsPage; label: string; group: string | null; icon: () => ReactNode }[] = [
  { id: "general", label: "General", group: null, icon: IconSliders },
  { id: "appearance", label: "Appearance", group: null, icon: IconPalette },
  { id: "usage", label: "Usage", group: null, icon: IconChart },
  { id: "providers", label: "Providers", group: "Agents", icon: IconBot },
  { id: "failover", label: "Model fallback", group: "Agents", icon: IconCircleArrowUp },
  { id: "anywhere", label: "Anywhere", group: "Agents", icon: IconAnywhere },
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
              <Tooltip label="Close" shortcut="Esc">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close settings"
                  onClick={closeSettings}
                >
                  <IconClose />
                </button>
              </Tooltip>
            </div>
          </header>
          <div className="settings-scroll" data-settings-page-scroll="">
            <div className="settings-content">
              {page === "general" ? <GeneralPage /> : null}
              {page === "appearance" ? <AppearanceSettings /> : null}
              {page === "providers" ? <ProvidersPage /> : null}
              {page === "failover" ? <FailoverSettings /> : null}
              {page === "anywhere" ? <AnywhereSettings /> : null}
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
    wallpaperMotion: _motion,
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
      <NotificationSettings />
      <SettingsSection title="Usage">
        <SettingRow
          title="Import usage from local agent history"
          description="Reads token counts and model names from Claude Code, Cursor, OpenCode and Codex history on this machine. Message text is never read or stored."
        >
          <Toggle
            checked={settings.importLocalHistory}
            onChange={(checked) => void patchDeviceSettings({ importLocalHistory: checked })}
            label="Import usage from local agent history"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

type Selection =
  { type: "provider"; kind: ProviderKind } | { type: "agent"; id: string } | { type: "new-agent" };

const NO_AGENTS: readonly AcpAgentConfig[] = [];

function ProvidersPage() {
  const providers = useStore((state) => state.providers);
  const settings = useStore((state) => state.deviceSettings);
  const [chosen, setSelected] = useState<Selection | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [presetAgent, setPresetAgent] = useState<{ key: number; agent: AcpAgentConfig } | null>(
    null,
  );
  const providerDraft = useSettingsDraft("providers", "Could not save the provider settings.");
  const agentDraft = useSettingsDraft("acpAgents", "Could not save the agents.");

  // sync: load device settings for provider options, defaults and agents
  useEffect(() => {
    void loadDeviceSettings();
  }, []);

  if (!settings || !providerDraft.value || !agentDraft.value) {
    return (
      <div className="settings-sections">
        <p className="empty-state small">Loading settings.</p>
      </div>
    );
  }

  const records = providerDraft.value;
  const agents = agentDraft.value ?? NO_AGENTS;
  // Agents get their own rows, so the aggregate ACP entry stays out of the provider rows.
  const rows = providers.filter((entry) => entry.kind !== "acp");
  const acpStatus = providers.find((entry) => entry.kind === "acp");
  const agentIds = new Set(agents.map((agent) => agent.id));
  const disabled = new Set(settings.disabledProviders);

  const selection: Selection | null =
    chosen?.type === "new-agent" ||
    (chosen?.type === "agent" && agentIds.has(chosen.id)) ||
    (chosen?.type === "provider" && rows.some((entry) => entry.kind === chosen.kind))
      ? chosen
      : rows[0]
        ? { type: "provider", kind: rows[0].kind }
        : null;
  const activeProvider =
    selection?.type === "provider"
      ? (rows.find((entry) => entry.kind === selection.kind) ?? null)
      : null;
  const activeAgent =
    selection?.type === "agent"
      ? (agents.find((agent) => agent.id === selection.id) ?? null)
      : null;

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

  const saveAgent = (agent: AcpAgentConfig) =>
    agentDraft.save(agents.map((entry) => (entry.id === agent.id ? agent : entry)));

  const agentSummary = (agent: AcpAgentConfig) =>
    !agent.enabled
      ? { headline: "Disabled", detail: null as string | null, tone: "muted" as const }
      : acpStatus
        ? providerSummary(acpStatus, true)
        : { headline: "Waiting for adapter", detail: null, tone: "muted" as const };

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
        {providers.length === 0 && agents.length === 0 ? (
          <p className="settings-help">No providers reported yet. Refresh to probe your PATH.</p>
        ) : null}
        <div className="providers-panel">
          <div className="providers-list">
            <div role="listbox" aria-label="Providers">
              {rows.map((provider) => {
                const enabled = !disabled.has(provider.kind);
                return (
                  <ProviderRow
                    key={provider.kind}
                    kind={provider.kind}
                    name={provider.label}
                    version={provider.version}
                    summary={providerSummary(provider, enabled)}
                    selected={selection?.type === "provider" && selection.kind === provider.kind}
                    dimmed={!enabled}
                    onSelect={() => setSelected({ type: "provider", kind: provider.kind })}
                    actions={
                      <Toggle
                        checked={enabled}
                        onChange={(checked) => setEnabled(provider.kind, checked)}
                        label={`Enable ${provider.label}`}
                      />
                    }
                  />
                );
              })}
            </div>
            <p className="providers-list-heading">Agents you add</p>
            {agents.length > 0 ? (
              <div role="listbox" aria-label="Agents you added">
                {agents.map((agent) => (
                  <ProviderRow
                    key={agent.id}
                    kind="acp"
                    name={agent.name}
                    version={null}
                    summary={agentSummary(agent)}
                    selected={selection?.type === "agent" && selection.id === agent.id}
                    dimmed={!agent.enabled}
                    onSelect={() => setSelected({ type: "agent", id: agent.id })}
                    actions={
                      <Toggle
                        checked={agent.enabled}
                        onChange={(enabled) => saveAgent({ ...agent, enabled })}
                        label={`Enable ${agent.name}`}
                      />
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="providers-list-empty">
                Any agent that speaks the Agent Client Protocol, such as Gemini CLI, Goose or Kiro.
              </p>
            )}
            <div className="providers-list-add">
              <button
                type="button"
                className="ghost-button"
                disabled={agents.length >= LIMITS.agents}
                aria-pressed={selection?.type === "new-agent"}
                onClick={() => {
                  setPresetAgent(null);
                  setSelected({ type: "new-agent" });
                }}
              >
                <IconPlus />
                Add agent
              </button>
            </div>
          </div>
          <div className="provider-detail" data-provider-detail="">
            {activeProvider ? (
              <ProviderDetail
                key={activeProvider.kind}
                provider={activeProvider}
                enabled={!disabled.has(activeProvider.kind)}
                onEnabledChange={(checked) => setEnabled(activeProvider.kind, checked)}
                settings={records[activeProvider.kind]}
                busy={providerDraft.busy}
                onSettingsChange={(patch) =>
                  providerDraft.save(updateProviderSettings(records, activeProvider.kind, patch))
                }
              />
            ) : activeAgent ? (
              <div className="provider-detail-inner">
                <header className="provider-detail-head">
                  <div className="provider-detail-title">
                    <ProviderMark kind="acp" />
                    <h4>{activeAgent.name}</h4>
                  </div>
                </header>
                <div className="provider-detail-block">
                  <p className="setting-title">Status</p>
                  <p className="provider-detail-status">
                    {agentSummary(activeAgent).headline}
                    {agentSummary(activeAgent).detail
                      ? ` · ${agentSummary(activeAgent).detail}`
                      : ""}
                  </p>
                </div>
                <AgentEditor
                  key={activeAgent.id}
                  mode="edit"
                  agent={activeAgent}
                  otherIds={new Set([...agentIds].filter((id) => id !== activeAgent.id))}
                  onSave={saveAgent}
                  onDelete={() => {
                    agentDraft.save(agents.filter((entry) => entry.id !== activeAgent.id));
                    setSelected(null);
                  }}
                />
              </div>
            ) : selection?.type === "new-agent" ? (
              <div className="provider-detail-inner">
                <header className="provider-detail-head">
                  <div className="provider-detail-title">
                    <ProviderMark kind="acp" />
                    <h4>Add agent</h4>
                  </div>
                </header>
                <AgentPresets
                  onPick={(preset) =>
                    setPresetAgent({
                      key: (presetAgent?.key ?? 0) + 1,
                      agent: agentFromPreset(preset, agentIds),
                    })
                  }
                />
                <AgentEditor
                  key={presetAgent?.key ?? 0}
                  mode="create"
                  agent={presetAgent?.agent ?? null}
                  otherIds={agentIds}
                  onSave={(agent) => {
                    agentDraft.save([...agents, agent]);
                    setPresetAgent(null);
                    setSelected({ type: "agent", id: agent.id });
                  }}
                />
              </div>
            ) : (
              <p className="muted">No providers configured.</p>
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function ProviderRow({
  kind,
  name,
  version,
  summary,
  selected,
  dimmed,
  onSelect,
  actions,
}: {
  kind: ProviderKind;
  name: string;
  version: string | null;
  summary: { headline: string; detail: string | null; tone: "error" | "muted" | "ok" };
  selected: boolean;
  dimmed: boolean;
  onSelect: () => void;
  actions: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      className={
        selected ? "provider-row selected" : dimmed ? "provider-row disabled" : "provider-row"
      }
    >
      <button
        type="button"
        className="provider-row-hit"
        aria-label={`Select ${name}`}
        onClick={onSelect}
      />
      <ProviderMark kind={kind} />
      <span className="provider-row-copy">
        <span className="provider-row-title">
          <span className="provider-row-name">{name}</span>
          {version ? <code className="provider-row-version">v{version}</code> : null}
        </span>
        <span
          className={summary.tone === "error" ? "provider-row-status error" : "provider-row-status"}
        >
          {summary.tone === "error" ? <span className="provider-status-dot" aria-hidden /> : null}
          <span>
            {summary.headline}
            {summary.detail ? ` · ${summary.detail}` : ""}
          </span>
        </span>
      </span>
      <span className="provider-row-actions">{actions}</span>
    </div>
  );
}

function ProviderDetail({
  provider,
  enabled,
  onEnabledChange,
  settings,
  busy,
  onSettingsChange,
}: {
  provider: ProviderStatus;
  enabled: boolean;
  onEnabledChange: (checked: boolean) => void;
  settings: ProviderSettings | undefined;
  busy: boolean;
  onSettingsChange: (patch: Partial<ProviderSettings>) => void;
}) {
  const [busyKind, setBusyKind] = useState<ProviderKind | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: ProviderKind;
    error: boolean;
    message: string;
  } | null>(null);
  const summary = providerSummary(provider, enabled);
  const canSignIn = provider.kind !== "demo";
  const needsSignIn = canSignIn && (provider.authenticated === false || !provider.installed);
  const connected =
    enabled && provider.installed && provider.authenticated !== false && !provider.problem;
  const signingIn = busyKind === provider.kind;
  const shown = feedback?.kind === provider.kind ? feedback : null;

  const onSignIn = async () => {
    const kind = provider.kind;
    setBusyKind(kind);
    try {
      const result = await connectProvider(kind);
      setFeedback({ kind, error: !result.ok, message: result.message });
    } finally {
      setBusyKind((current) => (current === kind ? null : current));
    }
  };

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
        {canSignIn ? (
          <div className="provider-connect-row">
            <button
              type="button"
              className={needsSignIn || !connected ? "button primary" : "ghost-button"}
              disabled={signingIn}
              aria-busy={signingIn}
              onClick={() => void onSignIn()}
            >
              {needsSignIn || !connected ? "Sign in" : "Sign in again"}
            </button>
            <p
              className={shown?.error ? "provider-detail-status error" : "setting-desc"}
              role={shown?.error ? "alert" : "status"}
            >
              {shown?.message ?? "Opens Terminal to sign in. Finish there, then press Refresh."}
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

      <ProviderSettingsPanel
        kind={provider.kind}
        status={provider}
        settings={settings}
        busy={busy}
        onChange={onSettingsChange}
      />
    </div>
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

function ProjectsPage() {
  const projects = useStore((state) => state.model.projects);
  const list = Object.values(projects).filter((project) => project.scratch !== true);
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
        <code className="mono">WOOKY_HOME/themes</code> so you or an agent can edit them.
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
