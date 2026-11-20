import type { PendingEvent, SyncPush } from "@wooky/contracts";
import type { Effect } from "../orchestrator/effects.ts";
import type { EventStore } from "../store/event-store.ts";
import type { ThemeStore } from "../settings/themes.ts";
import type { ProviderKind } from "@wooky/contracts";
import { claimAlreadyReleased, executeClaimStep } from "./claim.ts";
import { createReplicaService, type ReplicaService } from "./replicas.ts";
import type { AuthenticateRequest, PeerDirectory, SyncNow } from "./types.ts";
import { applyRemoteSettings } from "./settings-sync.ts";

export interface TransferService {
  replicas: ReplicaService;
  runClaimThread(effect: Extract<Effect, { kind: "claimThread" }>): Promise<void>;
  recoverClaims(): void;
  pullSettingsAndThemes(): Promise<void>;
}

export function createTransferService(deps: {
  home: string;
  store: EventStore;
  themes: ThemeStore;
  deviceId: string;
  peers: PeerDirectory;
  authenticate: AuthenticateRequest;
  syncNow: SyncNow;
  dispatch: (
    command: import("@wooky/contracts").Command,
  ) => import("@wooky/contracts").RpcResult<"dispatch">;
  newId: (prefix: string) => string;
  now: () => string;
  hasProvider: (kind: ProviderKind) => boolean;
  broadcastSync(push: SyncPush): void;
}): TransferService {
  const failClaim = (claimId: string, reason: string) => {
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
          const response = await fetch(new URL("/sync/settings", peer.baseUrl), {
            headers: { Authorization: `Bearer ${peer.token}` },
          });
          if (!response.ok) continue;
          const body = (await response.json()) as {
            values: Record<string, unknown>;
            stamps: Record<string, { updatedAt: string; deviceId: string }>;
          };
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
          const response = await fetch(new URL("/sync/themes", peer.baseUrl), {
            headers: { Authorization: `Bearer ${peer.token}` },
          });
          if (!response.ok) continue;
          const body = (await response.json()) as { themes: Array<{ theme: unknown }> };
          for (const row of body.themes) {
            try {
              deps.themes.put(row.theme as Parameters<typeof deps.themes.put>[0]);
            } catch {
              // skip invalid themes
            }
          }
        } catch (error) {
          console.error("Theme sync failed", error);
        }
      }
    }
  }

  async function runClaimThread(effect: Extract<Effect, { kind: "claimThread" }>): Promise<void> {
    await replicas.pullNow(effect.projectId);
    const settings = deps.themes.getSettings();
    const map = settings.sync.projectMap[effect.projectId];
    const localProjectId = map?.[deps.deviceId] ?? effect.projectId;

    const result = await executeClaimStep({
      store: deps.store,
      peers: deps.peers,
      localDeviceId: deps.deviceId,
      replicas: replicas.model,
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
      hasProvider: (kind) => deps.hasProvider(kind as ProviderKind),
      defaultProvider: { provider: "demo", model: "demo" },
    });

    if (!result.ok) failClaim(effect.claimId, result.reason);
  }

  function recoverClaims(): void {
    const pending = deps.store.model.pendingClaims ?? {};
    for (const claim of Object.values(pending)) {
      const released = claimAlreadyReleased(
        replicas.model,
        claim.ownerDeviceId,
        claim.ownerThreadId,
      );
      void runClaimThread({
        kind: "claimThread",
        threadId: claim.claimId,
        claimId: claim.claimId,
        ownerDeviceId: claim.ownerDeviceId,
        ownerThreadId: claim.ownerThreadId,
        projectId: claim.projectId,
        ...(released ? {} : {}),
      }).catch((error) => {
        failClaim(claim.claimId, error instanceof Error ? error.message : "Claim recovery failed");
      });
    }
  }

  return { replicas, runClaimThread, recoverClaims, pullSettingsAndThemes };
}
