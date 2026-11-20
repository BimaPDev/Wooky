import { activeTurn } from "@wooky/domain";
import type { DeviceSettings } from "@wooky/contracts";
import type { EventStore } from "../store/event-store.ts";
import { loadDeviceId } from "./device.ts";
import { createSyncEngine, type SyncEngine } from "./engine.ts";
import { createSyncRoutes } from "./http.ts";
import type { AuthenticateRequest, PeerDirectory } from "./types.ts";

/**
 * The sync engine bound to this server: reads projects and running turns from the read
 * model, snapshots when a turn finishes, and mounts the peer routes.
 */
export function createSyncService(options: {
  home: string;
  store: EventStore;
  settings: () => Pick<DeviceSettings, "sync">;
  authenticate: AuthenticateRequest;
  peers: PeerDirectory;
}) {
  const { store } = options;
  const engine: SyncEngine = createSyncEngine({
    home: options.home,
    deviceId: loadDeviceId(options.home),
    settings: options.settings,
    peers: options.peers,
    projects: () =>
      Object.values(store.model.projects).map((p) => ({
        id: p.id,
        root: p.root,
        scratch: p.scratch,
      })),
    turnRunning: (projectId) =>
      Object.values(store.model.threads).some(
        (thread) => thread.projectId === projectId && activeTurn(store.model, thread.id) !== null,
      ),
    notice: (projectId, message) => console.warn(`[sync] ${projectId || "-"}: ${message}`),
  });
  const unsubscribe = store.subscribe((events) => {
    for (const event of events) {
      if (event.type !== "turn.finished") continue;
      const thread = store.model.threads[event.threadId];
      if (!thread) continue;
      void engine.turnFinished({
        projectId: thread.projectId,
        threadId: event.threadId,
        turnId: event.turnId,
      });
    }
  });
  engine.refresh();
  return {
    engine,
    routes: createSyncRoutes(engine, options.authenticate),
    async close() {
      unsubscribe();
      await engine.stop();
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
