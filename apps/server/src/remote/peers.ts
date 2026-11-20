import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
  Environment,
  PairResponse,
  RemoteConnection,
  type DeviceInfo,
  type DeviceSettings,
  type Environment as EnvironmentRecord,
  type RemoteConnection as RemoteConnectionRecord,
} from "@wooky/contracts";
import { z } from "zod";
import { ServiceError } from "../errors.ts";
import { createSshTunnels, type SshTunnelSpec } from "../process/ssh-tunnel.ts";
import { writePrivateJson } from "./files.ts";

const StoredPeer = z.object({
  environmentId: z.string().min(1),
  hostDeviceId: z.string().min(1),
  name: z.string().min(1),
  connection: RemoteConnection,
  token: z.string().min(1),
  localPort: z.number().int().min(1).max(65535).optional(),
});
type StoredPeer = z.infer<typeof StoredPeer>;

const JOIN_TIMEOUT_MS = 15_000;

const StoreFile = z.object({ peers: z.array(StoredPeer) });

export interface PeerRecord {
  deviceId: string;
  name: string;
  baseUrl: string;
  token: string;
}

export interface PeerDirectory {
  list(): PeerRecord[];
  get(deviceId: string): PeerRecord | undefined;
}

function httpBase(connection: RemoteConnectionRecord, localPort?: number): string {
  switch (connection.kind) {
    case "direct":
    case "url":
      return connection.url.replace(/\/$/, "");
    case "tailscale": {
      const scheme = connection.https ? "https" : "http";
      if (connection.https && connection.port === 443) return `${scheme}://${connection.hostName}`;
      return `${scheme}://${connection.hostName}:${connection.port}`;
    }
    case "ssh": {
      const port = localPort ?? connection.localPort;
      return port ? `http://127.0.0.1:${port}` : "http://127.0.0.1";
    }
  }
}

function wsUrl(base: string): string {
  const url = new URL(base.includes("://") ? base : `http://${base}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sshSpec(
  connection: Extract<RemoteConnectionRecord, { kind: "ssh" }>,
  localPort?: number,
): SshTunnelSpec {
  return {
    target: connection.target,
    remotePort: connection.remotePort,
    ...((localPort ?? connection.localPort)
      ? { localPort: localPort ?? connection.localPort }
      : {}),
    ...(connection.identityFile ? { identityFile: connection.identityFile } : {}),
  };
}

export function createPeers(options: {
  home: string;
  now?: () => number;
  deviceInfo: () => DeviceInfo;
  getSettings: () => DeviceSettings;
  putSettings: (patch: { environments: EnvironmentRecord[] }) => DeviceSettings;
  tunnels?: ReturnType<typeof createSshTunnels>;
  /** How long `join` waits for the remote to answer. Default 15 seconds. */
  joinTimeoutMs?: number;
}): PeerDirectory & {
  join(input: {
    connection: RemoteConnectionRecord;
    code: string;
    label?: string;
  }): Promise<{ environment: EnvironmentRecord; host: DeviceInfo }>;
  connectInfo(environmentId: string): Promise<{ wsUrl: string; token: string }>;
  retain(environmentIds: readonly string[]): void;
  close(): void;
} {
  const path = pathJoin(options.home, "peers.json");
  const now = options.now ?? Date.now;
  const tunnels = options.tunnels ?? createSshTunnels();
  let peers = read();

  function read(): StoredPeer[] {
    try {
      const parsed = StoreFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success ? parsed.data.peers : [];
    } catch {
      return [];
    }
  }

  function write(next: StoredPeer[]): void {
    peers = next;
    writePrivateJson(path, { peers: next });
  }

  /** The label the user gave the machine when adding it, else the name the device calls itself. */
  function labelFor(peer: StoredPeer): string {
    try {
      const environment = options
        .getSettings()
        .environments.find((item) => item.id === peer.environmentId);
      const label = environment?.label.trim();
      if (label) return label;
    } catch {
      // settings not readable yet: fall back to the device's own name
    }
    return peer.name;
  }

  function toRecord(peer: StoredPeer): PeerRecord {
    return {
      deviceId: peer.hostDeviceId,
      name: labelFor(peer),
      baseUrl: httpBase(peer.connection, peer.localPort),
      token: peer.token,
    };
  }

  function list(): PeerRecord[] {
    return peers.map(toRecord);
  }

  function get(deviceId: string): PeerRecord | undefined {
    const peer = peers.find((item) => item.hostDeviceId === deviceId);
    return peer ? toRecord(peer) : undefined;
  }

  async function openSsh(
    environmentId: string,
    connection: Extract<RemoteConnectionRecord, { kind: "ssh" }>,
    localPort?: number,
  ): Promise<number> {
    return tunnels.ensure(environmentId, sshSpec(connection, localPort));
  }

  async function join(input: {
    connection: RemoteConnectionRecord;
    code: string;
    label?: string;
  }): Promise<{ environment: EnvironmentRecord; host: DeviceInfo }> {
    const environmentId = randomUUID();
    let localPort: number | undefined;
    try {
      if (input.connection.kind === "ssh") {
        localPort = await openSsh(environmentId, input.connection);
      }
      // The code and device identity go only to the address the user typed. A redirect
      // would carry them to a host the user never chose.
      const response = await fetch(new URL("/pair", httpBase(input.connection, localPort)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: input.code, device: options.deviceInfo() }),
        redirect: "manual",
        signal: AbortSignal.timeout(options.joinTimeoutMs ?? JOIN_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        throw new ServiceError(
          "bad_request",
          `The remote redirected the pairing request${location ? ` to ${location}` : ""}.`,
        );
      }
      const text = await response.text();
      if (!response.ok) {
        throw new ServiceError(
          response.status === 429 ? "unavailable" : "bad_request",
          text.slice(0, 300) || "Pairing failed.",
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ServiceError(
          "unavailable",
          "The remote returned an unreadable pairing response.",
        );
      }
      const body = PairResponse.parse(raw);
      const environment = Environment.parse({
        id: environmentId,
        label: input.label ?? body.host.name,
        deviceId: body.host.deviceId,
        connection: input.connection,
        addedAt: new Date(now()).toISOString(),
      });
      const stored: StoredPeer = {
        environmentId,
        hostDeviceId: body.host.deviceId,
        name: body.host.name,
        connection: input.connection,
        token: body.token,
        ...(localPort ? { localPort } : {}),
      };
      write(peers.concat(stored));
      try {
        const settings = options.getSettings();
        options.putSettings({ environments: [...settings.environments, environment] });
      } catch (error) {
        write(peers.filter((peer) => peer.environmentId !== environmentId));
        throw error;
      }
      return { environment, host: body.host };
    } catch (error) {
      tunnels.stop(environmentId);
      if (error instanceof ServiceError) throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ServiceError("unavailable", "The remote did not answer within 15 seconds.");
      }
      throw new ServiceError(
        "unavailable",
        error instanceof Error ? error.message : "Could not join that device.",
      );
    }
  }

  async function connectInfo(environmentId: string): Promise<{ wsUrl: string; token: string }> {
    const peer = peers.find((item) => item.environmentId === environmentId);
    if (!peer) throw new ServiceError("not_found", `No paired environment ${environmentId}.`);
    if (peer.connection.kind === "ssh") {
      const localPort = await openSsh(environmentId, peer.connection, peer.localPort);
      if (peer.localPort !== localPort) {
        write(
          peers.map((item) =>
            item.environmentId === environmentId ? { ...item, localPort } : item,
          ),
        );
      }
    }
    const fresh = peers.find((item) => item.environmentId === environmentId) ?? peer;
    return { wsUrl: wsUrl(httpBase(fresh.connection, fresh.localPort)), token: fresh.token };
  }

  function retain(environmentIds: readonly string[]): void {
    const keep = new Set(environmentIds);
    const removed = peers.filter((peer) => !keep.has(peer.environmentId));
    if (removed.length === 0) return;
    for (const peer of removed) tunnels.stop(peer.environmentId);
    write(peers.filter((peer) => keep.has(peer.environmentId)));
  }

  function close(): void {
    tunnels.stopAll();
  }

  return { list, get, join, connectInfo, retain, close };
}
