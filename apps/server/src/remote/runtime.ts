import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { DeviceSettings, DeviceSettingsPatch, HostingSettings } from "@wooky/contracts";
import type { ThemeStore } from "../settings/themes.ts";
import { createRequestAuth, type AuthenticateRequest } from "./auth.ts";
import { createBindManager } from "./bind.ts";
import { createDevice } from "./device.ts";
import { createGuardedHandler } from "./http.ts";
import { createPairing } from "./pairing.ts";
import { createPeers, type PeerDirectory } from "./peers.ts";
import { createTailscale, type Tailscale, type TailscaleReport } from "./tailscale.ts";

export interface RemoteRuntime {
  authenticateRequest: AuthenticateRequest;
  addressOf(req: IncomingMessage): string | undefined;
  device: ReturnType<typeof createDevice>;
  pairing: ReturnType<typeof createPairing>;
  peers: PeerDirectory & Pick<ReturnType<typeof createPeers>, "join" | "connectInfo" | "retain">;
  tailscaleStatus(): Promise<TailscaleReport>;
  disableServe(): Promise<void>;
  track(deviceId: string, socket: import("ws").WebSocket): void;
  onSettings(
    before: DeviceSettings,
    after: DeviceSettings,
    patch: DeviceSettingsPatch,
  ): Promise<void>;
  listen(options: {
    handler: (req: IncomingMessage, res: ServerResponse) => void;
    onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  }): Promise<{ url: string; port: number }>;
  /** Loopback port of the token-only listener behind Tailscale Serve, when open. */
  servePort(): number | null;
  servers(): import("node:http").Server[];
  addresses(): string[];
  port(): number;
  url(): string;
  closeTunnels(): void;
  closeServers(): Promise<void>;
}

export function createRemoteRuntime(options: {
  home: string;
  themes: ThemeStore;
  host: string;
  port: number;
  hostExplicit?: boolean;
  portExplicit?: boolean;
  now?: () => number;
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  tailscale?: Tailscale;
}): RemoteRuntime {
  const now = options.now ?? Date.now;
  const tailscale = options.tailscale ?? createTailscale();
  const device = createDevice({
    home: options.home,
    getSettings: () => options.themes.getSettings(),
    putSettings: (patch) => options.themes.putSettings(patch),
    now: () => new Date(now()).toISOString(),
  });

  const addressOf = (req: IncomingMessage) =>
    options.remoteAddress ? options.remoteAddress(req) : req.socket.remoteAddress;

  let closeDevice: (deviceId: string) => void = () => {};
  const bind = createBindManager({
    host: options.host,
    port: options.port,
    hostExplicit: options.hostExplicit === true,
    portExplicit: options.portExplicit === true,
    getHosting: () => options.themes.getSettings().hosting,
    tailnetIps: async () => (await tailscale.status()).ips,
  });
  const pairing = createPairing({
    home: options.home,
    now,
    hostInfo: () => device.info(),
    listenPort: () => bind.port(),
    hosting: () => options.themes.getSettings().hosting,
    tailscaleStatus: () => tailscale.status(),
    onRevoke: (deviceId) => closeDevice(deviceId),
  });
  const auth = createRequestAuth({ addressOf, lookup: (token) => pairing.lookup(token) });
  closeDevice = (deviceId) => auth.closeDevice(deviceId);
  const peers = createPeers({
    home: options.home,
    now,
    deviceInfo: () => device.info(),
    getSettings: () => options.themes.getSettings(),
    putSettings: (patch) => options.themes.putSettings(patch),
  });

  /**
   * Tailscale Serve proxies from loopback, so it gets its own listener that always
   * demands a device token. The main listener's loopback trust never reaches it.
   */
  async function enableServe(): Promise<void> {
    try {
      await tailscale.serve(await bind.openServe());
    } catch (error) {
      tailscale.reportServeError(error instanceof Error ? error.message : "serve listener failed");
    }
  }

  async function disableServe(): Promise<void> {
    try {
      await tailscale.serveOff();
    } finally {
      await bind.closeServe();
    }
  }

  async function syncServe(before: HostingSettings, after: HostingSettings): Promise<void> {
    const was = before.enabled && before.tailscaleServe;
    const enabled = after.enabled && after.tailscaleServe;
    if (enabled && !was) await enableServe();
    else if (was && !enabled) await disableServe();
  }

  async function onSettings(
    before: DeviceSettings,
    after: DeviceSettings,
    patch: DeviceSettingsPatch,
  ): Promise<void> {
    if (patch.environments) peers.retain(after.environments.map((environment) => environment.id));
    if (!patch.hosting) return;
    await bind.apply();
    await syncServe(before.hosting, after.hosting);
  }

  return {
    authenticateRequest: auth.authenticateRequest,
    addressOf,
    device,
    pairing,
    peers,
    tailscaleStatus: () => tailscale.status(),
    disableServe,
    track: (deviceId, socket) => auth.track(deviceId, socket),
    onSettings,
    async listen({ handler, onUpgrade }) {
      bind.setHandler(
        createGuardedHandler({
          authenticateRequest: auth.authenticateRequest,
          addressOf,
          redeem: (raw, remoteAddress) => pairing.redeem(raw, remoteAddress),
          staticHandler: handler,
        }),
      );
      bind.setUpgrade(onUpgrade);
      const listening = await bind.apply();
      const hosting = options.themes.getSettings().hosting;
      if (hosting.enabled && hosting.tailscaleServe) await enableServe();
      return listening;
    },
    servePort: () => bind.servePort(),
    servers: () => bind.servers(),
    addresses: () => bind.addresses(),
    port: () => bind.port(),
    url: () => bind.url(),
    closeTunnels: () => peers.close(),
    closeServers: () => bind.closeServers(),
  };
}
