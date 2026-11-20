import type { DeviceSettings, SyncCategories } from "@wooky/contracts";
import { useState } from "react";
import { backend } from "../../../state/backend.ts";
import {
  putSettings,
  useDeviceInfo,
  usePairedDevices,
  useSyncStatus,
} from "../../../state/environments.ts";
import { useStore } from "../../../state/store.ts";
import { formatWhen } from "../format.ts";
import { Row, SettingsBlock, Toggle } from "./controls.tsx";

const CATEGORIES: { key: keyof SyncCategories; title: string; description: string }[] = [
  {
    key: "files",
    title: "Project files",
    description: "Working copies, including uncommitted changes.",
  },
  {
    key: "threads",
    title: "Threads and history",
    description: "Conversations, turns, checkpoints and the queue.",
  },
  {
    key: "settings",
    title: "Settings",
    description: "Device settings, except keys that stay on this machine.",
  },
  { key: "themes", title: "Themes", description: "Themes and wallpapers." },
  {
    key: "ignoredFiles",
    title: "Ignored files",
    description: "Also sync files matched by .gitignore. This can copy .env files and other secrets, and it can be large.",
  },
];

export function SyncSection({ settings }: { settings: DeviceSettings }) {
  const status = useSyncStatus();
  const device = useDeviceInfo();
  const paired = usePairedDevices();
  const sync = settings.sync;
  const [syncing, setSyncing] = useState(false);

  const peers = peerChoices(settings, device?.deviceId ?? null, paired);
  const liveProjects = useStore((state) =>
    Object.values(state.model.projects).filter((project) => project.scratch !== true),
  );

  const syncNow = async () => {
    setSyncing(true);
    try {
      await backend().call("sync.now", {});
    } catch (error) {
      useStore.setState({
        notice: error instanceof Error ? error.message : "Could not start a sync.",
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <SettingsBlock
      title="Sync"
      action={
        <button
          type="button"
          className="button"
          disabled={!sync.enabled || syncing}
          title={sync.enabled ? "Sync now" : "Turn sync on to sync now."}
          onClick={() => void syncNow()}
        >
          {syncing ? "Syncing" : "Sync now"}
        </button>
      }
    >
      <Row
        title="Sync with peers"
        description="Off until you turn it on. A running task stays on the machine that started it."
      >
        <Toggle
          checked={sync.enabled}
          label="Sync with peers"
          onChange={(checked) => void putSettings({ sync: { enabled: checked } })}
        />
      </Row>
      {!sync.enabled ? (
        <p className="settings-help">Sync is off. These choices apply once you turn it on.</p>
      ) : null}
      {CATEGORIES.map((category) => (
        <Row key={category.key} title={category.title} description={category.description}>
          <Toggle
            checked={sync.categories[category.key]}
            label={category.title}
            onChange={(checked) =>
              void putSettings({ sync: { categories: { [category.key]: checked } } })
            }
          />
        </Row>
      ))}
      {sync.categories.ignoredFiles ? (
        <p className="anywhere-warn" role="status">
          Ignored files include secrets such as .env, and they can make each snapshot large.
        </p>
      ) : null}
      <NumberCommit
        label="Interval"
        description="How often to scan project files, in seconds. Turns also snapshot when they finish."
        value={sync.intervalSec}
        min={5}
        max={3600}
        onCommit={(intervalSec) => void putSettings({ sync: { intervalSec } })}
      />
      <NumberCommit
        label="Keep days"
        description="Drop snapshots older than this many days, after the minimum below is kept."
        value={sync.retention.keepDays}
        min={0}
        max={3650}
        onCommit={(keepDays) => void putSettings({ sync: { retention: { keepDays } } })}
      />
      <NumberCommit
        label="Minimum snapshots"
        description="Always keep at least this many snapshots, even when they are older than the day limit."
        value={sync.retention.keepMin}
        min={0}
        max={10000}
        onCommit={(keepMin) => void putSettings({ sync: { retention: { keepMin } } })}
      />
      <div className="anywhere-block">
        <p className="setting-title">Peers</p>
        <p className="setting-desc">Which paired devices and machines to sync with.</p>
        {peers.length === 0 ? (
          <p className="setting-desc">Pair a device or add a machine first.</p>
        ) : (
          <ul className="anywhere-list">
            {peers.map((peer) => {
              const on = sync.peers.includes(peer.id);
              return (
                <li key={peer.id} className="anywhere-check">
                  <label>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...sync.peers, peer.id]
                          : sync.peers.filter((id) => id !== peer.id);
                        void putSettings({ sync: { peers: next } });
                      }}
                    />
                    <span>{peer.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="anywhere-block">
        <p className="setting-title">Project folders</p>
        <p className="setting-desc">The path of each project on each peer. Leave a cell empty to skip it.</p>
        {sync.peers.length === 0 || liveProjects.length === 0 ? (
          <p className="setting-desc">Choose a peer, and add a project, to map folders.</p>
        ) : (
          <div className="anywhere-table-wrap">
            <table className="anywhere-table">
              <thead>
                <tr>
                  <th>Project</th>
                  {sync.peers.map((id) => (
                    <th key={id}>{peers.find((peer) => peer.id === id)?.name ?? id}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {liveProjects.map((project) => (
                  <tr key={project.id}>
                    <th scope="row">
                      {project.name}
                      <span className="mono muted">{project.root}</span>
                    </th>
                    {sync.peers.map((deviceId) => (
                      <td key={deviceId}>
                        <PathCell
                          value={sync.projectMap[project.id]?.[deviceId] ?? ""}
                          label={`${project.name} on ${peers.find((peer) => peer.id === deviceId)?.name ?? deviceId}`}
                          onCommit={(path) => {
                            const projectMap = withPath(sync.projectMap, project.id, deviceId, path);
                            void putSettings({ sync: { projectMap } });
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="anywhere-block">
        <p className="setting-title">Status</p>
        {!status || status.peers.length === 0 ? (
          <p className="setting-desc">No sync activity yet.</p>
        ) : (
          <ul className="anywhere-list">
            {status.peers.map((peer) => (
              <li key={peer.deviceId} className="anywhere-status">
                <span className={`env-dot env-${dotFor(peer.state)}`} />
                <span>
                  <strong>{peer.name}</strong>
                  <span className="muted">
                    {" "}
                    · {peer.state}
                    {peer.lastSyncAt ? ` · ${formatWhen(peer.lastSyncAt)}` : ""}
                  </span>
                  {peer.error ? <span className="field-error"> {peer.error}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsBlock>
  );
}

function peerChoices(
  settings: DeviceSettings,
  selfId: string | null,
  paired: { deviceId: string; name: string; revoked: boolean }[],
) {
  const map = new Map<string, string>();
  for (const device of paired) {
    if (!device.revoked) map.set(device.deviceId, device.name);
  }
  for (const environment of settings.environments) {
    if (environment.deviceId && !map.has(environment.deviceId)) {
      map.set(environment.deviceId, environment.label);
    }
  }
  if (selfId) map.delete(selfId);
  return [...map].map(([id, name]) => ({ id, name }));
}

function withPath(
  map: DeviceSettings["sync"]["projectMap"],
  projectId: string,
  deviceId: string,
  path: string,
) {
  const next: DeviceSettings["sync"]["projectMap"] = {};
  for (const [id, paths] of Object.entries(map)) next[id] = { ...paths };
  const row = { ...(next[projectId] ?? {}) };
  if (path) row[deviceId] = path;
  else delete row[deviceId];
  if (Object.keys(row).length > 0) next[projectId] = row;
  else delete next[projectId];
  return next;
}

function dotFor(state: string) {
  if (state === "idle" || state === "syncing") return state === "syncing" ? "pending" : "open";
  if (state === "error" || state === "offline") return "offline";
  return "unknown";
}

function NumberCommit({
  label,
  description,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = text ?? String(value);
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">{label}</p>
        <p className="setting-desc">{description}</p>
        {error ? <p className="field-error">{error}</p> : null}
      </div>
      <input
        className="anywhere-number"
        inputMode="numeric"
        aria-label={label}
        value={shown}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = Number(shown);
          if (!Number.isInteger(next) || next < min || next > max) {
            setError(`Use a whole number from ${min} to ${max}.`);
            return;
          }
          setError(null);
          setText(null);
          if (next !== value) onCommit(next);
        }}
      />
    </div>
  );
}

function PathCell({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (path: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  return (
    <input
      className="mono"
      aria-label={label}
      value={shown}
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const next = shown.trim();
        setText(null);
        if (next !== value) onCommit(next);
      }}
    />
  );
}
