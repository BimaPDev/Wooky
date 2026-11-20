import { z } from "zod";
import {
  AgeEvent,
  type DeviceSettings,
  type ReplicaModel,
  type SyncStatus,
} from "@wooky/contracts";
import { applyReplicaEvents, emptyReplicaModel } from "@wooky/domain";
import type { EventStore } from "../store/event-store.ts";
import type { PeerDirectory } from "../remote/peers.ts";
import { fetchPeerJson } from "./peer-fetch.ts";
import type { SyncNow } from "./types.ts";

const BATCH = 2_000;

function replicaEventTypes(type: string): boolean {
  return type.startsWith("thread.") || type.startsWith("turn.");
}

const ThreadBatch = z.object({
  events: z.array(z.unknown()).max(BATCH),
  nextSince: z.number().int().nonnegative(),
});

/**
 * A peer only owns thread and turn events, in increasing seq order after `since`.
 * Anything else, or anything that does not decode, is dropped.
 */
export function acceptReplicaEvents(raw: readonly unknown[], since: number): AgeEvent[] {
  const accepted: AgeEvent[] = [];
  let last = since;
  for (const item of raw) {
    const parsed = AgeEvent.safeParse(item);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (!replicaEventTypes(event.type) || event.seq <= last) continue;
    last = event.seq;
    accepted.push(event);
  }
  return accepted;
}

export interface ReplicaService {
  readonly model: ReplicaModel;
  foldOwner(ownerDeviceId: string): void;
  /** Drops an owner's in-memory slice. Call after pruning its stored events, then foldOwner. */
  forget(ownerDeviceId: string): void;
  /** Pulls files for `projectId` (a local project id) from `ownerDeviceId`, then every peer's threads. */
  pullNow(projectId?: string, ownerDeviceId?: string): Promise<void>;
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
  syncNow: SyncNow;
  /** Status with the file-sync state. Defaults to a plain list of the peers. */
  status?: () => SyncStatus;
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
      const body = await fetchPeerJson(
        peer,
        "/sync/threads",
        { since: String(since) },
        ThreadBatch,
      );
      if (!body || body.events.length === 0) break;
      deps.store.appendReplicaEvents(ownerDeviceId, acceptReplicaEvents(body.events, since));
      // A batch that does not move the cursor would loop forever.
      if (body.nextSince <= since) break;
      since = body.nextSince;
      foldOwner(ownerDeviceId);
      if (body.events.length < BATCH) break;
    }
  };

  const pullAllPeers = async () => {
    const settings = deps.settings();
    if (!settings.sync.enabled || !settings.sync.categories.threads) return;
    const results = await Promise.allSettled(settings.sync.peers.map((id) => pullPeer(id)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  };

  return {
    get model() {
      return model;
    },
    foldOwner,
    forget(ownerDeviceId) {
      const { [ownerDeviceId]: _gone, ...rest } = model.replicas;
      model = { ...model, replicas: rest };
    },
    syncStatus() {
      if (deps.status) return deps.status();
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
    async pullNow(projectId, ownerDeviceId) {
      const settings = deps.settings();
      if (!settings.sync.enabled) return;
      // Files are a separate category from threads: wait for them even when threads are off.
      if (projectId) await deps.syncNow(projectId, ownerDeviceId);
      if (settings.sync.categories.threads) await pullAllPeers();
    },
    async pullAll() {
      await pullAllPeers();
    },
    start() {
      const settings = deps.settings();
      for (const ownerId of settings.sync.peers) foldOwner(ownerId);
      if (timer) return;
      timer = setInterval(() => {
        pullAllPeers().catch((error) => console.error("Thread sync failed", error));
      }, settings.sync.intervalSec * 1000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
