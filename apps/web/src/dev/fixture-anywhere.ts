import type {
  DeviceInfo,
  RpcParams,
  Environment,
  PairedDeviceView,
  SyncStatus,
  TailscaleStatus,
} from "@wooky/contracts";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** The machine the fixture client already knows, so the switcher has something to show. */
export const FIXTURE_ENVIRONMENTS: Environment[] = [
  {
    id: "env-home",
    label: "Home server",
    deviceId: "dev-home",
    connection: { kind: "tailscale", hostName: "home.tailnet.ts.net", port: 4317, https: true },
    addedAt: ago(60 * 24 * 9),
  },
];

let device: DeviceInfo = {
  deviceId: "dev-fixture",
  name: "Work MacBook",
  platform: "darwin",
  version: "0.0.0",
};

const tailscale: TailscaleStatus = {
  installed: true,
  running: true,
  hostName: "work-mac.tailnet.ts.net",
  ips: ["100.101.102.103"],
};

let paired: PairedDeviceView[] = [
  {
    deviceId: "dev-phone",
    name: "Safari on iOS",
    platform: "other",
    pairedAt: ago(60 * 24 * 3),
    lastSeenAt: ago(12),
    revoked: false,
  },
  {
    deviceId: "dev-home",
    name: "Home server",
    platform: "linux",
    pairedAt: ago(60 * 24 * 9),
    lastSeenAt: ago(2),
    revoked: false,
  },
];

const syncStatus: SyncStatus = {
  enabled: false,
  peers: [
    { deviceId: "dev-home", name: "Home server", state: "idle", lastSyncAt: ago(4), error: null },
  ],
  conflicts: [],
};

const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function pairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)];
  }
  return code;
}

/** Anywhere methods for the browser fixture. Returns `undefined` for a method it does not own. */
export function respondAnywhere(method: string, params: unknown): unknown {
  switch (method) {
    case "device.info":
      return device;
    case "device.rename":
      device = { ...device, name: (params as RpcParams<"device.rename">).name };
      return device;
    case "remote.tailscaleStatus":
      return tailscale;
    case "remote.pairingCode.create":
      return {
        code: pairingCode(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        url: "http://100.101.102.103:4317",
      };
    case "remote.devices.list":
      return paired;
    case "remote.devices.revoke": {
      const id = (params as RpcParams<"remote.devices.revoke">).deviceId;
      paired = paired.map((entry) => (entry.deviceId === id ? { ...entry, revoked: true } : entry));
      return { ok: true as const };
    }
    case "remote.devices.rename": {
      const { deviceId, name } = params as RpcParams<"remote.devices.rename">;
      paired = paired.map((entry) => (entry.deviceId === deviceId ? { ...entry, name } : entry));
      return paired.find((entry) => entry.deviceId === deviceId);
    }
    case "sync.status":
      return syncStatus;
    case "sync.now":
      return { ok: true as const };
    // TODO(A1): remote.join and remote.connectInfo move to contracts when A1 merges.
    case "remote.join": {
      const { connection, label } = params as { connection: Environment["connection"]; label?: string };
      const id = `env-${Math.random().toString(36).slice(2, 8)}`;
      return {
        environment: {
          id,
          label: label ?? "New machine",
          connection,
          addedAt: new Date().toISOString(),
        },
        host: { deviceId: id, name: label ?? "New machine", platform: "linux", version: "0.0.0" },
      };
    }
    case "remote.connectInfo": {
      const { environmentId } = params as { environmentId: string };
      return { wsUrl: `ws://fixture.invalid/${environmentId}/ws`, token: "fixture-token" };
    }
    default:
      return undefined;
  }
}
