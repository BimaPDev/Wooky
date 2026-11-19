import type { FailoverSettings as FailoverConfig, ProviderCooldown } from "@age/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { loadDeviceSettings, patchDeviceSettings } from "../state/appearance.ts";
import { useStore } from "../state/store.ts";
import { ChainEditor } from "./failover/ChainEditor.tsx";
import { useMinuteClock } from "./failover/clock.ts";
import { activeCooldowns, cooldownRowText, relativeLabel } from "./failover/format.ts";

type Trigger = FailoverConfig["triggers"][number];

const TRIGGERS: { id: Trigger; label: string }[] = [
  { id: "rate_limit", label: "Rate limit" },
  { id: "quota", label: "Quota" },
  { id: "overloaded", label: "Overloaded" },
];

const NO_COOLDOWNS: Readonly<Record<string, ProviderCooldown>> = {};

function Row({
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

function Switch({
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

export function FailoverSettings() {
  const saved = useStore((state) => state.deviceSettings?.failover);
  const providers = useStore((state) => state.providers);
  const cooldowns = useStore((state) => state.model.cooldowns ?? NO_COOLDOWNS);
  const nowMs = useMinuteClock();
  const [draft, setDraft] = useState<FailoverConfig | null>(null);

  // sync: load device settings when the page mounts
  useEffect(() => {
    void loadDeviceSettings();
  }, []);

  const settings = draft ?? saved;
  if (!settings) return <p className="empty-state small">Loading settings.</p>;

  const save = (patch: Partial<FailoverConfig>) => {
    const next = { ...settings, ...patch };
    setDraft(next);
    void patchDeviceSettings({ failover: next }).finally(() =>
      setDraft((current) => (current === next ? null : current)),
    );
  };

  const off = !settings.enabled;
  const limited = activeCooldowns(cooldowns, providers, nowMs);
  const toggleTrigger = (id: Trigger, on: boolean) =>
    save({
      triggers: on
        ? TRIGGERS.map((t) => t.id).filter((t) => t === id || settings.triggers.includes(t))
        : settings.triggers.filter((t) => t !== id),
    });

  return (
    <div className="settings-sections">
      <section className="settings-section">
        <div className="settings-section-head">
          <h3>Model fallback</h3>
        </div>
        <div className="settings-card">
          <Row
            title="Switch models automatically when an agent hits a limit"
            description="Wooky moves the thread to the next model in your list and retries the same prompt."
          >
            <Switch
              checked={settings.enabled}
              onChange={(enabled) => save({ enabled })}
              label="Switch models automatically when an agent hits a limit"
            />
          </Row>
          <ChainEditor
            chain={settings.chain}
            providers={providers}
            cooldowns={cooldowns}
            nowMs={nowMs}
            disabled={off}
            onChange={(chain) => save({ chain: [...chain] })}
          />
          <Row
            title="Max switches per prompt"
            description="Stop switching after this many fallback attempts for one prompt."
          >
            <div className="failover-stepper" role="group" aria-label="Max switches per prompt">
              <button
                type="button"
                className="icon-button"
                aria-label="Decrease max switches"
                disabled={off || settings.maxSwitchesPerPrompt <= 1}
                onClick={() => save({ maxSwitchesPerPrompt: settings.maxSwitchesPerPrompt - 1 })}
              >
                −
              </button>
              <output aria-live="polite">{settings.maxSwitchesPerPrompt}</output>
              <button
                type="button"
                className="icon-button"
                aria-label="Increase max switches"
                disabled={off || settings.maxSwitchesPerPrompt >= 6}
                onClick={() => save({ maxSwitchesPerPrompt: settings.maxSwitchesPerPrompt + 1 })}
              >
                +
              </button>
            </div>
          </Row>
          <Row
            title="Switch back when the limit resets"
            description="Return the thread to its original model once that model is available again."
          >
            <Switch
              checked={settings.switchBack}
              onChange={(switchBack) => save({ switchBack })}
              label="Switch back when the limit resets"
            />
          </Row>
          <fieldset className="failover-triggers" disabled={off}>
            <legend className="setting-title">Switch when an agent reports</legend>
            <div className="failover-checks">
              {TRIGGERS.map((trigger) => (
                <label key={trigger.id} className="failover-check">
                  <input
                    type="checkbox"
                    checked={settings.triggers.includes(trigger.id)}
                    onChange={(event) => toggleTrigger(trigger.id, event.target.checked)}
                  />
                  {trigger.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-head">
          <h3>Current limits</h3>
        </div>
        <div className="settings-card">
          {limited.length === 0 ? (
            <p className="settings-help">No models are limited right now.</p>
          ) : (
            <ul className="failover-limits">
              {limited.map((row) => (
                <li key={row.key} className="failover-limit">
                  <span>{cooldownRowText(row, nowMs)}</span>
                  <span className="muted">{relativeLabel(row.until, nowMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
