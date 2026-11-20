import type { DeviceSettings } from "@wooky/contracts";
import { useEffect, useState } from "react";
import { useEnvironmentSession, useEnvironments } from "../../../state/environments.ts";
import { loadDeviceSettings } from "../../../state/appearance.ts";
import {
  putSettings,
  refreshDevice,
  refreshPaired,
  refreshSyncStatus,
  refreshListen,
  refreshTailscale,
  renameDevice,
  useDeviceInfo,
  useListenInfo,
  useTailscale,
} from "../../../state/environments.ts";
import { useStore } from "../../../state/store.ts";
import { platformLabel } from "../format.ts";
import { AddMachineForm } from "./AddMachineForm.tsx";
import { Row, SettingsBlock, Toggle } from "./controls.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { Modal } from "../../Modal.tsx";
import { PairingSection } from "./PairingSection.tsx";
import { SyncSection } from "./SyncSection.tsx";
import { confirm } from "../../../state/actions.ts";

const BINDS: {
  id: DeviceSettings["hosting"]["bind"];
  title: string;
  description: string;
}[] = [
  {
    id: "tailscale",
    title: "Tailscale",
    description: "Reachable on your tailnet, at this machine's tailnet address.",
  },
  {
    id: "all",
    title: "All interfaces",
    description: "Listen on every network interface.",
  },
  {
    id: "loopback",
    title: "Local only",
    description: "Only this machine. Use SSH or a tunnel to expose it.",
  },
];

export function AnywhereSettings() {
  const settings = useStore((state) => state.deviceSettings);
  const sessionRemote = useEnvironmentSession().remote;
  const [problem, setProblem] = useState<string | null>(null);

  // sync: device, tailscale, paired devices and sync status from the server
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadDeviceSettings();
        await Promise.all([
          refreshDevice(),
          refreshTailscale(),
          refreshListen(),
          refreshPaired(),
          refreshSyncStatus(),
        ]);
      } catch (error) {
        if (!cancelled) {
          setProblem(
            error instanceof Error
              ? error.message
              : "Anywhere is not available on this server yet.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) return <p className="empty-state small">Loading settings.</p>;

  return (
    <div className="settings-sections">
      {problem ? <p className="anywhere-warn">{problem}</p> : null}
      <ThisDevice />
      <Hosting settings={settings} />
      {sessionRemote ? null : <PairingSection />}
      {sessionRemote ? null : <DevicesSection />}
      <Environments />
      <SyncSection settings={settings} />
    </div>
  );
}

function ThisDevice() {
  const device = useDeviceInfo();
  const [name, setName] = useState<string | null>(null);
  if (!device) return <p className="settings-help">Reading this device.</p>;
  const shown = name ?? device.name;
  return (
    <SettingsBlock title="This device">
      <label className="field anywhere-inset">
        <span>Name</span>
        <input
          aria-label="Device name"
          value={shown}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            const next = shown.trim();
            setName(null);
            if (next && next !== device.name) {
              void renameDevice(next).catch((error: unknown) => {
                useStore.setState({
                  notice: error instanceof Error ? error.message : "Could not rename this device.",
                });
              });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <p className="settings-help">
        {platformLabel(device.platform)} · version {device.version}
      </p>
    </SettingsBlock>
  );
}

function Hosting({ settings }: { settings: DeviceSettings }) {
  const tailscale = useTailscale();
  const listen = useListenInfo();
  const hosting = settings.hosting;
  const tailscaleRunning = Boolean(tailscale?.running);
  return (
    <SettingsBlock title="Hosting">
      <Row
        title="Accept remote clients"
        description="Off until you enable it. Loopback stays open either way."
      >
        <Toggle
          checked={hosting.enabled}
          label="Accept remote clients"
          onChange={(checked) => void putSettings({ hosting: { enabled: checked } })}
        />
      </Row>
      <fieldset className="anywhere-bind">
        <legend className="setting-title">Bind</legend>
        {BINDS.map((bind) => {
          const disabled = bind.id === "tailscale" && !tailscaleRunning;
          return (
            <label key={bind.id} className="option">
              <input
                type="radio"
                name="hosting-bind"
                value={bind.id}
                checked={hosting.bind === bind.id}
                disabled={disabled}
                onChange={() => void putSettings({ hosting: { bind: bind.id } })}
              />
              <span>
                <strong>{bind.title}</strong>
                <span className="muted"> · {bind.description}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {!tailscale?.installed ? (
        <p className="settings-help">
          Tailscale is not installed.{" "}
          <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
            Install Tailscale
          </a>
          . Tailscale bind stays unavailable until it is running.
        </p>
      ) : !tailscaleRunning ? (
        <p className="settings-help">
          Tailscale is installed but not running, so that bind is off.
        </p>
      ) : null}
      {hosting.bind === "all" ? (
        <p className="anywhere-warn" role="status">
          Anyone on your network can reach the sign-in page. Paired devices still need a token.
        </p>
      ) : null}
      <PortRow
        port={hosting.port}
        override={listen?.portExplicit ? listen.port : null}
        onCommit={(port) => void putSettings({ hosting: { port } })}
      />
      {tailscaleRunning ? (
        <Row
          title="Serve over HTTPS with Tailscale"
          description="tailscale serve puts this host on HTTPS port 443."
        >
          <Toggle
            checked={hosting.tailscaleServe}
            label="Serve over HTTPS with Tailscale"
            onChange={(checked) => void putSettings({ hosting: { tailscaleServe: checked } })}
          />
        </Row>
      ) : null}
    </SettingsBlock>
  );
}

export function PortRow({
  port,
  override,
  onCommit,
}: {
  port: number;
  /** The port a `--port` / WOOKY_PORT override fixes, or null when the setting rules. */
  override: number | null;
  onCommit: (port: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = text ?? String(port);
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">Port</p>
        <p className="setting-desc">The port remote clients connect to. 1 to 65535.</p>
        {override !== null ? (
          <p className="anywhere-warn" role="status">
            This server was started with an explicit port, so it is listening on {override} whatever
            is set here. This setting applies after a restart without that port option.
          </p>
        ) : null}
        {error ? <p className="field-error">{error}</p> : null}
      </div>
      <input
        className="anywhere-number"
        inputMode="numeric"
        aria-label="Port"
        value={shown}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = Number(shown);
          if (!Number.isInteger(next) || next < 1 || next > 65535) {
            setError("Use a port from 1 to 65535.");
            return;
          }
          setError(null);
          setText(null);
          if (next !== port) onCommit(next);
        }}
      />
    </div>
  );
}

function Environments() {
  const tailscale = useTailscale();
  const environments = useEnvironments();
  const session = useEnvironmentSession();
  const [adding, setAdding] = useState(false);
  if (session.remote) {
    return (
      <SettingsBlock title="Other machines">
        <p className="settings-help">
          You are viewing {session.label}. Switch to your own machine to add or remove machines.
        </p>
      </SettingsBlock>
    );
  }
  return (
    <SettingsBlock
      title="Other machines"
      action={
        <button type="button" className="button" onClick={() => setAdding(true)}>
          Add machine
        </button>
      }
    >
      {environments.length === 0 ? (
        <p className="settings-help">
          No other machines yet. Add one to switch to it from the sidebar.
        </p>
      ) : (
        <ul className="anywhere-list">
          {environments.map((environment) => (
            <li key={environment.id} className="anywhere-device">
              <div>
                <p className="setting-title">{environment.label}</p>
                <p className="setting-desc mono">{connectionSummary(environment.connection)}</p>
              </div>
              <button
                type="button"
                className="ghost-button danger"
                aria-label={`Remove ${environment.label}`}
                onClick={() =>
                  confirm({
                    title: `Remove ${environment.label}`,
                    body: "It leaves the switcher on this client. The other machine is not unpaired.",
                    confirmLabel: "Remove",
                    onConfirm: () => {
                      void putSettings({
                        environments: environments.filter((entry) => entry.id !== environment.id),
                      });
                    },
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <Modal label="Add machine" onClose={() => setAdding(false)} className="modal">
          <AddMachineForm onClose={() => setAdding(false)} tailscaleHint={tailscale?.hostName} />
        </Modal>
      ) : null}
    </SettingsBlock>
  );
}

function connectionSummary(
  connection: DeviceSettings["environments"][number]["connection"],
): string {
  switch (connection.kind) {
    case "tailscale":
      return `${connection.hostName}:${connection.port}${connection.https ? " · https" : ""}`;
    case "direct":
    case "url":
      return connection.url;
    case "ssh":
      return `ssh ${connection.target}:${connection.remotePort}`;
  }
}
