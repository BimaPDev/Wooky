import { HistoryTurn, type ReplicaModel, type ReadModel } from "@wooky/contracts";
import { handoffTranscript } from "@wooky/domain";
import type { EventStore } from "../store/event-store.ts";
import type { PeerDirectory } from "./types.ts";
import { remoteDispatch } from "./remote-rpc.ts";

export function historyFromReplica(
  replicas: ReplicaModel,
  ownerDeviceId: string,
  ownerThreadId: string,
): { turns: HistoryTurn[]; thread: ReadModel["threads"][string] | undefined } {
  const slice = replicas.replicas[ownerDeviceId];
  const thread = slice?.threads[ownerThreadId];
  const turns = (slice?.turns[ownerThreadId] ?? []).filter((turn) => turn.status !== "running");
  const parsed = HistoryTurn.array().safeParse(turns);
  return {
    thread,
    turns: parsed.success ? parsed.data : [],
  };
}

export function transcriptForImport(
  replicas: ReplicaModel,
  ownerDeviceId: string,
  ownerThreadId: string,
): string {
  const slice = replicas.replicas[ownerDeviceId];
  if (!slice) return "";
  const model: ReadModel = {
    seq: slice.seq,
    projects: {},
    threads: slice.threads,
    turns: slice.turns,
    cooldowns: {},
    groups: {},
    reviewNotes: {},
    pendingClaims: {},
  };
  return handoffTranscript(model, ownerThreadId, 24_000);
}

export async function executeClaimStep(params: {
  store: EventStore;
  peers: PeerDirectory;
  localDeviceId: string;
  replicas: ReplicaModel;
  claimId: string;
  ownerDeviceId: string;
  ownerThreadId: string;
  projectId: string;
  force?: boolean;
  syncNow: (projectId: string) => Promise<void>;
  newId: (prefix: string) => string;
  now: () => string;
  settingsProjectMap: (projectId: string) => string | null;
  hasProvider: (kind: string) => boolean;
  defaultProvider: { provider: string; model: string };
  importThread(event: import("@wooky/contracts").PendingEvent): void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const peer = params.peers.get(params.ownerDeviceId);
  if (!peer) return { ok: false, reason: "The owner device is not paired." };

  const localProjectId = params.settingsProjectMap(params.projectId) ?? params.projectId;
  if (!params.store.model.projects[localProjectId])
    return { ok: false, reason: "This project is not mapped on this device." };

  const ownerThread = params.replicas.replicas[params.ownerDeviceId]?.threads[params.ownerThreadId];
  if (ownerThread?.movedTo) return { ok: false, reason: "The owner already released this thread." };

  await params.syncNow(params.projectId);

  if (!ownerThread?.movedTo) {
    try {
      await remoteDispatch(peer.baseUrl, peer.token, {
        commandId: `release:${params.claimId}`,
        type: "thread.release",
        threadId: params.ownerThreadId,
        toDeviceId: params.localDeviceId,
        ...(params.force ? { force: true } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Release failed";
      if (message.includes("running")) {
        return { ok: false, reason: "The owner is still working on that thread." };
      }
      return {
        ok: false,
        reason: message === "Connection closed" ? "The owner is offline." : message,
      };
    }
  }

  const { turns, thread } = historyFromReplica(
    params.replicas,
    params.ownerDeviceId,
    params.ownerThreadId,
  );
  const source = thread ?? ownerThread;
  if (!source) return { ok: false, reason: "Thread replica not found yet. Try again after sync." };

  let provider = source.provider;
  let model = source.model;
  if (!params.hasProvider(provider)) {
    provider = params.defaultProvider.provider as typeof source.provider;
    model = params.defaultProvider.model;
  }

  const transcript = transcriptForImport(
    params.replicas,
    params.ownerDeviceId,
    params.ownerThreadId,
  );

  const threadId = params.newId("thread");
  const at = params.now();
  try {
    params.importThread({
      type: "thread.imported",
      commandId: `import:${params.claimId}`,
      thread: {
        id: threadId,
        projectId: localProjectId,
        title: source.title,
        provider,
        model,
        runtimeMode: source.runtimeMode,
        worktree: null,
        providerSessionId: null,
        ownerDeviceId: null,
        movedTo: null,
        movedFrom: null,
        pullRequest: null,
        queue: [],
        status: "idle",
        createdAt: at,
        updatedAt: at,
      },
      sourceDeviceId: params.ownerDeviceId,
      sourceThreadId: params.ownerThreadId,
      transcript,
      historyTurns: turns,
      claimId: params.claimId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    return { ok: false, reason: message };
  }
  return { ok: true };
}

export function claimAlreadyReleased(
  replicas: ReplicaModel,
  ownerDeviceId: string,
  ownerThreadId: string,
): boolean {
  return Boolean(replicas.replicas[ownerDeviceId]?.threads[ownerThreadId]?.movedTo);
}
