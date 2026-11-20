import type { SyncSettings } from "@wooky/contracts";

import type { PeerDirectory } from "../remote/peers.ts";

export interface SyncProject {
  id: string;
  root: string;
  /** Shown to peers so they can match the project by name. */
  name?: string | undefined;
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
  /** Git facts of a project folder (remote, branch). Tests replace it. */
  projectFacts?: (root: string) => Promise<import("../git/project-info.ts").ProjectGitFacts>;
  now?: () => Date;
  timers?: SyncTimers;
  fetch?: typeof fetch;
  notice?: (projectId: string, message: string) => void;
  /** Largest single file a snapshot takes or an apply writes. Tests lower it. */
  maxFileBytes?: number;
  /** Largest total of incoming blobs one apply writes. Tests lower it. */
  maxApplyBytes?: number;
  /** Called when the last sync write into a project folder finishes. */
  onWritingEnd?: (projectId: string) => void;
  /** Delay before the first retention pass after start. Defaults to 10 minutes. */
  retentionStartDelayMs?: number;
}
