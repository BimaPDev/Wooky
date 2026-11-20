import { z } from "zod";
import {
  AppearanceTheme,
  type PendingEvent,
  type SyncPush,
  type SyncStatus,
} from "@wooky/contracts";
import type { Effect } from "../orchestrator/effects.ts";
import type { EventStore } from "../store/event-store.ts";
import type { ThemeStore } from "../settings/themes.ts";
import type { ProviderKind } from "@wooky/contracts";
import { executeClaimStep } from "./claim.ts";
import { createReplicaService, type ReplicaService } from "./replicas.ts";
import type { AuthenticateRequest } from "../remote/auth.ts";
import type { PeerDirectory } from "../remote/peers.ts";
import type { SyncNow } from "./types.ts";
import { resolveLocalProjectId } from "./project.ts";
import { applyRemoteSettings } from "./settings-sync.ts";
import { fetchPeerJson } from "./peer-fetch.ts";

const HOUR_MS = 3_600_000;
/** A claim that never reached the owner is given up after this long. */
export const CLAIM_TTL_MS = HOUR_MS;
/** A leftover release marker with no pending claim is dropped after this long. */
export const CHECKPOINT_TTL_MS = 24 * HOUR_MS;
/** An idle replicated thread nobody touched for this long is forgotten. */
export const REPLICA_KEEP_MS = 90 * 24 * HOUR_MS;

const SettingsBody = z.object({
  values: z.record(z.string(), z.unknown()),
  stamps: z.record(z.string(), z.object({ updatedAt: z.string().max(40), deviceId: z.string() })),
});
const ThemesBody = z.object({
  themes: z.array(z.object({ theme: z.unknown() })).max(200),
});
const SETTINGS_BODY_BYTES = 1024 * 1024;
const THEMES_BODY_BYTES = 64 * 1024 * 1024;

export interface TransferService {
  replicas: ReplicaService;
  runClaimThread(effect: Extract<Effect, { kind: "claimThread" }>): Promise<void>;
  recoverClaims(): void;
  pullSettingsAndThemes(): Promise<void>;
  /** Prunes replica events and stale claims. Safe to call at any time. */
  housekeeping(): void;
  start(): void;
  stop(): void;
}

export function createTransferService(deps: {
  home: string;
  store: EventStore;
  themes: ThemeStore;
  deviceId: string;
  peers: PeerDirectory;
  authenticate: AuthenticateRequest;
  /** Brings project files from the owner before and after a claim. See `createClaimFileSync`. */
  syncNow: SyncNow;
  /** Sync status with file-sync state, for pushes. */
  syncStatus?: () => SyncStatus;
  dispatch: (
    command: import("@wooky/contracts").Command,
  ) => import("@wooky/contracts").RpcResult<"dispatch">;
  newId: (prefix: string) => string;
  now: () => string;
  hasProvider: (kind: ProviderKind) => boolean;
  broadcastSync(push: SyncPush): void;
  /** Test seams for the force-release wait. */
  releaseAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): TransferService {
  const failClaim = (claimId: string, reason: string) => {
    deps.store.clearClaimReleased(claimId);
    if (!deps.store.model.pendingClaims?.[claimId]) return;
    const event: PendingEvent = {
      type: "thread.claimFailed",
      commandId: null,
      claimId,
      reason,
    };
    deps.store.appendInternal([event]);
  };

  const replicas = createReplicaService({
    store: deps.store,
    peers: deps.peers,
    settings: () => deps.themes.getSettings(),
    syncNow: deps.syncNow,
    ...(deps.syncStatus ? { status: deps.syncStatus } : {}),
    onChange() {
      deps.broadcastSync({
        push: "sync",
        kind: "status",
        ...replicas.syncStatus(),
      });
    },
  });

  async function pullSettingsAndThemes(): Promise<void> {
    const settings = deps.themes.getSettings();
    if (!settings.sync.enabled) return;
    for (const peerId of settings.sync.peers) {
      const peer = deps.peers.get(peerId);
      if (!peer) continue;
      if (settings.sync.categories.settings) {
        try {
          const body = await fetchPeerJson(
            peer,
            "/sync/settings",
            {},
            SettingsBody,
            SETTINGS_BODY_BYTES,
          );
          if (body)
            applyRemoteSettings(
              deps.home,
              deps.deviceId,
              deps.themes,
              body.values,
              body.stamps,
              deps.newId,
              deps.now(),
            );
        } catch (error) {
          console.error("Settings sync failed", error);
        }
      }
      if (settings.sync.categories.themes) {
        try {
          const body = await fetchPeerJson(peer, "/sync/themes", {}, ThemesBody, THEMES_BODY_BYTES);
          for (const row of body?.themes ?? []) {
            const theme = AppearanceTheme.safeParse(row.theme);
            if (!theme.success) continue;
            // A theme this device already has is kept as is: a peer never overwrites local edits.
            if (hasTheme(theme.data.id)) continue;
            try {
              deps.themes.put(theme.data);
            } catch {
              // put runs the CSS and SVG safety checks; a theme that fails them is skipped
            }
          }
        } catch (error) {
          console.error("Theme sync failed", error);
        }
      }
    }
  }

  function hasTheme(id: string): boolean {
    try {
      deps.themes.get(id);
      return true;
    } catch {
      return false;
    }
  }

  const inflight = new Map<string, Promise<void>>();

  /** The effect runner and startup recovery can both ask for the same claim; it runs once. */
  function runClaimThread(effect: Extract<Effect, { kind: "claimThread" }>): Promise<void> {
    const running = inflight.get(effect.claimId);
    if (running) return running;
    const run = runClaimOnce(effect).finally(() => inflight.delete(effect.claimId));
    inflight.set(effect.claimId, run);
    return run;
  }

  async function runClaimOnce(effect: Extract<Effect, { kind: "claimThread" }>): Promise<void> {
    if (!deps.store.model.pendingClaims?.[effect.claimId]) return;
    replicas.foldOwner(effect.ownerDeviceId);
    const settings = deps.themes.getSettings();
    const localProjectId =
      resolveLocalProjectId(
        effect.projectId,
        deps.deviceId,
        settings.sync.projectMap,
        deps.store.model.projects,
      ) ?? effect.projectId;
    try {
      await replicas.pullNow(localProjectId, effect.ownerDeviceId);
    } catch (error) {
      if (!deps.store.isClaimReleased(effect.claimId)) {
        failClaim(
          effect.claimId,
          error instanceof Error ? error.message : "Could not reach the owner device.",
        );
        return;
      }
      // Already released to us (a recovered claim): the thread is ours, so it is imported
      // rather than lost, and the missing files are logged.
      console.warn(
        `Claim ${effect.claimId}: files were not synced: ${error instanceof Error ? error.message : error}`,
      );
    }

    const result = await executeClaimStep({
      store: deps.store,
      peers: deps.peers,
      localDeviceId: deps.deviceId,
      getReplicas: () => replicas.model,
      pullReplicas: () => replicas.pullAll(),
      claimId: effect.claimId,
      ownerDeviceId: effect.ownerDeviceId,
      ownerThreadId: effect.ownerThreadId,
      projectId: effect.projectId,
      force: effect.force,
      syncNow: deps.syncNow,
      newId: deps.newId,
      now: deps.now,
      settingsProjectMap: () => localProjectId,
      importThread: (event) => {
        deps.store.appendInternal([event]);
      },
      ...(deps.releaseAttempts !== undefined ? { releaseAttempts: deps.releaseAttempts } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      hasProvider: (kind) => deps.hasProvider(kind as ProviderKind),
      defaultProvider: { provider: "demo", model: "demo" },
    });

    if (!result.ok) failClaim(effect.claimId, result.reason);
  }

  function recoverClaims(): void {
    const pending = deps.store.model.pendingClaims ?? {};
    for (const claim of Object.values(pending)) {
      replicas.foldOwner(claim.ownerDeviceId);
      void runClaimThread({
        kind: "claimThread",
        threadId: claim.claimId,
        claimId: claim.claimId,
        ownerDeviceId: claim.ownerDeviceId,
        ownerThreadId: claim.ownerThreadId,
        projectId: claim.projectId,
      }).catch((error) => {
        failClaim(claim.claimId, error instanceof Error ? error.message : "Claim recovery failed");
      });
    }
  }

  function housekeeping(): void {
    const now = Date.parse(deps.now());
    const pending = deps.store.model.pendingClaims ?? {};
    for (const claim of Object.values(pending)) {
      if (inflight.has(claim.claimId) || deps.store.isClaimReleased(claim.claimId)) continue;
      if (now - Date.parse(claim.at) > CLAIM_TTL_MS)
        failClaim(claim.claimId, "The claim timed out.");
    }
    for (const checkpoint of deps.store.claimCheckpoints()) {
      if (deps.store.model.pendingClaims?.[checkpoint.claimId]) continue;
      if (now - Date.parse(checkpoint.releasedAt) > CHECKPOINT_TTL_MS)
        deps.store.clearClaimReleased(checkpoint.claimId);
    }

    const peers = new Set(deps.themes.getSettings().sync.peers);
    for (const owner of deps.store.replicaOwners()) {
      if (peers.has(owner)) continue;
      deps.store.dropReplicaOwner(owner);
      replicas.forget(owner);
    }

    const local = Object.values(deps.store.model.threads);
    const claiming = new Set(
      Object.values(deps.store.model.pendingClaims ?? {}).map(
        (claim) => `${claim.ownerDeviceId}/${claim.ownerThreadId}`,
      ),
    );
    for (const [owner, slice] of Object.entries(replicas.model.replicas)) {
      const drop = new Set<string>();
      for (const thread of Object.values(slice.threads)) {
        if (claiming.has(`${owner}/${thread.id}`)) continue;
        const imported = local.some(
          (item) => item.movedFrom?.deviceId === owner && item.movedFrom.threadId === thread.id,
        );
        const stale =
          thread.status === "idle" && now - Date.parse(thread.updatedAt) > REPLICA_KEEP_MS;
        if (imported || stale) drop.add(thread.id);
      }
      for (const event of deps.store.replicaEventsAfter(owner, 0)) {
        if (event.type === "thread.removed") drop.add(event.threadId);
      }
      if (drop.size === 0) continue;
      deps.store.dropReplicaThreads(owner, [...drop]);
      replicas.forget(owner);
      replicas.foldOwner(owner);
    }
  }

  const timers: Array<ReturnType<typeof setInterval>> = [];
  function start(): void {
    replicas.start();
    housekeeping();
    const settingsTimer = setInterval(
      () => {
        pullSettingsAndThemes().catch((error) => console.error("Settings sync failed", error));
      },
      Math.max(5, deps.themes.getSettings().sync.intervalSec) * 1000,
    );
    const housekeepingTimer = setInterval(housekeeping, HOUR_MS);
    for (const timer of [settingsTimer, housekeepingTimer]) {
      timer.unref?.();
      timers.push(timer);
    }
  }
  function stop(): void {
    replicas.stop();
    for (const timer of timers.splice(0)) clearInterval(timer);
  }

  return {
    replicas,
    runClaimThread,
    recoverClaims,
    pullSettingsAndThemes,
    housekeeping,
    start,
    stop,
  };
}
