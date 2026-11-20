import type { IncomingMessage } from "node:http";
import type { SyncSettings } from "@wooky/contracts";

/** Supplied by the pairing station (A1). Loopback is `{ deviceId: "local" }`. */
export type AuthenticateRequest = (req: IncomingMessage) => { deviceId: string } | null;

export interface PeerEntry {
  deviceId: string;
  name: string;
  baseUrl: string;
  token: string;
}

/** Supplied by the pairing station (A1): the paired devices this server may call. */
export interface PeerDirectory {
  list(): PeerEntry[];
  get(deviceId: string): PeerEntry | null | undefined;
}

export interface SyncProject {
  id: string;
  root: string;
  scratch?: boolean | undefined;
}

export interface SyncTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncDeps {
  home: string;
  deviceId: string;
  settings(): { sync: SyncSettings };
  projects(): SyncProject[];
  turnRunning(projectId: string): boolean;
  peers: PeerDirectory;
  gitBin?: string;
  now?: () => Date;
  timers?: SyncTimers;
  fetch?: typeof fetch;
  notice?: (projectId: string, message: string) => void;
  /** Largest single file a snapshot takes. Tests lower it. */
  maxFileBytes?: number;
  /** Delay before the first retention pass after start. Defaults to 10 minutes. */
  retentionStartDelayMs?: number;
}
