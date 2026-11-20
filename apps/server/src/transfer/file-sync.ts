import type { DeviceSettings, SyncStatus } from "@wooky/contracts";
import type { SyncNow } from "./types.ts";

/** How long a claim waits for the owner's files before it says so and stops. */
export const FILE_SYNC_TIMEOUT_MS = 30_000;

export interface ClaimSyncEngine {
  now(projectId?: string): Promise<{ ok: true }>;
  status(): SyncStatus;
}

/**
 * Problems the engine recorded for one peer, narrowed to this project. The engine joins one
 * message per shared project ("<project>: <message>"). A project this device has not mapped is
 * not a problem the engine records, so it never reaches here.
 */
export function problemsFor(error: string, projectId: string): string[] {
  return error.split("; ").filter((part) => {
    const colon = part.indexOf(": ");
    if (colon < 0) return true;
    const prefix = part.slice(0, colon);
    // Project ids look like `project_<uuid>`; anything else is a message, not a prefix.
    return prefix === projectId || !/^[\w-]+$/.test(prefix);
  });
}

/**
 * The file sync a claim waits for. With file sync off there is nothing to wait for and it
 * returns at once. Otherwise it snapshots and pulls the project from the owner and waits for
 * the files, at most `timeoutMs`. It throws, with a plain reason, when the owner could not be
 * reached, refused, or did not finish in time, so a claim never imports a thread whose files
 * are missing without saying so.
 */
export function createClaimFileSync(deps: {
  settings: () => Pick<DeviceSettings, "sync">;
  engine: ClaimSyncEngine;
  peerName?: (deviceId: string) => string;
  timeoutMs?: number;
  /** Test seams for the wait. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}): SyncNow {
  const timeoutMs = deps.timeoutMs ?? FILE_SYNC_TIMEOUT_MS;
  const arm = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const disarm = deps.clearTimeout ?? ((handle) => clearTimeout(handle as never));

  return async (projectId, ownerDeviceId) => {
    const sync = deps.settings().sync;
    if (!sync.enabled || !sync.categories.files) return;
    const name = ownerDeviceId
      ? (deps.peerName?.(ownerDeviceId) ?? ownerDeviceId)
      : "the other device";
    if (ownerDeviceId && !sync.peers.includes(ownerDeviceId))
      throw new Error(`${name} is not a file sync peer, so its files cannot be synced.`);

    let timer: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = arm(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([deps.engine.now(projectId), timedOut]);
      if (outcome === "timeout") {
        const waited =
          timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} seconds`;
        throw new Error(
          `Files from ${name} did not finish syncing within ${waited}, so the claim was stopped. ` +
            "Check that it is online and try again.",
        );
      }
    } finally {
      disarm(timer);
    }

    if (!ownerDeviceId) return;
    const peer = deps.engine.status().peers.find((entry) => entry.deviceId === ownerDeviceId);
    if (!peer) throw new Error(`${name} is not a file sync peer, so its files cannot be synced.`);
    if (peer.state === "offline")
      throw new Error(
        `${name} could not be reached, so its files were not synced.${peer.error ? ` ${peer.error}` : ""}`,
      );
    if (peer.state === "error" && peer.error) {
      const problems = problemsFor(peer.error, projectId);
      if (problems.length > 0)
        throw new Error(`Files from ${name} did not sync: ${problems.join("; ")}`);
    }
  };
}
