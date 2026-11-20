import { useState } from "react";
import { confirm } from "../../../state/actions.ts";
import { renamePaired, revokePaired, usePairedDevices } from "../../../state/environments.ts";
import { useStore } from "../../../state/store.ts";
import { formatWhen, platformLabel } from "../format.ts";
import { SettingsBlock } from "./controls.tsx";

export function DevicesSection() {
  const devices = usePairedDevices().filter((device) => !device.revoked);
  return (
    <SettingsBlock title="Paired devices">
      {devices.length === 0 ? (
        <p className="settings-help">No devices are paired. Show a pairing code to add one.</p>
      ) : (
        <ul className="anywhere-list">
          {devices.map((device) => (
            <DeviceRow key={device.deviceId} device={device} />
          ))}
        </ul>
      )}
    </SettingsBlock>
  );
}

function DeviceRow({
  device,
}: {
  device: { deviceId: string; name: string; platform: string; pairedAt: string; lastSeenAt: string | null };
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);

  const save = async () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== device.name) {
      try {
        await renamePaired(device.deviceId, name);
      } catch (error) {
        useStore.setState({
          notice: error instanceof Error ? error.message : "Could not rename that device.",
        });
      }
    }
  };

  return (
    <li className="anywhere-device">
      <div>
        {renaming ? (
          <input
            className="inline-rename"
            aria-label={`Rename ${device.name}`}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") {
                setName(device.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <p className="setting-title">{device.name}</p>
        )}
        <p className="setting-desc">
          {platformLabel(device.platform)} · Paired {formatWhen(device.pairedAt)} · Last seen{" "}
          {formatWhen(device.lastSeenAt)}
        </p>
      </div>
      <div className="anywhere-actions">
        <button type="button" className="ghost-button" onClick={() => setRenaming(true)}>
          Rename
        </button>
        <button
          type="button"
          className="ghost-button danger"
          aria-label={`Revoke ${device.name}`}
          onClick={() =>
            confirm({
              title: `Revoke ${device.name}`,
              body: "This device is disconnected immediately. It will need a new pairing code to connect again.",
              confirmLabel: "Revoke",
              onConfirm: () => {
                void revokePaired(device.deviceId).catch((error: unknown) => {
                  useStore.setState({
                    notice: error instanceof Error ? error.message : "Could not revoke that device.",
                  });
                });
              },
            })
          }
        >
          Revoke
        </button>
      </div>
    </li>
  );
}
