import type { AgeEvent, DeviceSettings, ReplicaModel, SyncStatus } from "@wooky/contracts";
import { applyReplicaEvents, emptyReplicaModel } from "@wooky/domain";
import type { EventStore } from "../store/event-store.ts";
import type { PeerDirectory } from "./types.ts";

const BATCH = 2_000;

function replicaEventTypes(type: string): boolean {
  return type.startsWith("thread.") || type.startsWith("turn.");
}

export interface ReplicaService {
  readonly model: ReplicaModel;
  pullNow(projectId?: string): Promise<void>;
  pullAll(): Promise<void>;
  ownerBatch(
    since: number,
    peerDeviceId: string | null,
  ): {
    events: AgeEvent[];
    nextSince: number;
  };
  syncStatus(): SyncStatus;
  start(): void;
  stop(): void;
}

export function createReplicaService(deps: {
  store: EventStore;
  peers: PeerDirectory;
  settings: () => DeviceSettings;
  onChange(): void;
  syncNow: (projectId: string) => Promise<void>;
}): ReplicaService {
  let model = emptyReplicaModel();
  let timer: ReturnType<typeof setInterval> | null = null;

  const foldOwner = (ownerDeviceId: string) => {
    const since = model.replicas[ownerDeviceId]?.seq ?? 0;
    const events = deps.store.replicaEventsAfter(ownerDeviceId, since);
    if (events.length === 0) return;
    model = applyReplicaEvents(model, ownerDeviceId, events);
    deps.onChange();
  };

  const pullPeer = async (ownerDeviceId: string): Promise<void> => {
    const peer = deps.peers.get(ownerDeviceId);
    if (!peer) return;
    const settings = deps.settings();
    if (!settings.sync.enabled || !settings.sync.categories.threads) return;
    let since = deps.store.replicaHighWater(ownerDeviceId);
    for (;;) {
      const url = new URL("/sync/threads", peer.baseUrl);
      url.searchParams.set("since", String(since));
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${peer.token}` },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { events: AgeEvent[]; nextSince: number };
      if (body.events.length === 0) break;
      deps.store.appendReplicaEvents(ownerDeviceId, body.events);
      since = body.nextSince;
      foldOwner(ownerDeviceId);
      if (body.events.length < BATCH) break;
    }
  };

  const pullAllPeers = async () => {
    const settings = deps.settings();
    if (!settings.sync.enabled || !settings.sync.categories.threads) return;
    await Promise.all(settings.sync.peers.map((id) => pullPeer(id)));
  };

  return {
    get model() {
      return model;
    },
    syncStatus() {
      const settings = deps.settings();
      return {
        enabled: settings.sync.enabled,
        peers: settings.sync.peers.map((deviceId) => ({
          deviceId,
          name: deps.peers.get(deviceId)?.name ?? deviceId,
          state: "idle" as const,
          lastSyncAt: null,
          error: null,
        })),
        conflicts: [],
      };
    },
    ownerBatch(since, peerDeviceId) {
      const settings = deps.settings();
      if (!settings.sync.enabled || !settings.sync.categories.threads)
        return { events: [], nextSince: since };
      if (peerDeviceId && !settings.sync.peers.includes(peerDeviceId)) throw new Error("forbidden");
      const all = deps.store.eventsAfter(since).filter((event) => replicaEventTypes(event.type));
      const events = all.slice(0, BATCH);
      const nextSince = events.at(-1)?.seq ?? since;
      return { events, nextSince };
    },
    async pullNow(projectId) {
      const settings = deps.settings();
      if (!settings.sync.enabled || !settings.sync.categories.threads) return;
      if (projectId) await deps.syncNow(projectId);
      await pullAllPeers();
    },
    async pullAll() {
      await pullAllPeers();
    },
    start() {
      const settings = deps.settings();
      for (const ownerId of settings.sync.peers) foldOwner(ownerId);
      if (timer) return;
      timer = setInterval(() => {
        void pullAllPeers();
      }, settings.sync.intervalSec * 1000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
