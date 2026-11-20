import {
  HistoryTurn,
  type PendingEvent,
  type ReplicaModel,
  type ReadModel,
} from "@wooky/contracts";
import { handoffTranscript } from "@wooky/domain";
import type { EventStore } from "../store/event-store.ts";
import type { PeerDirectory } from "../remote/peers.ts";
import { importTitle, validateHistoryTurns } from "./history-validation.ts";
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

const RELEASE_ATTEMPTS = 40;
const RELEASE_DELAY_MS = 500;
const MAX_REASON = 300;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type ClaimStepParams = {
  store: EventStore;
  peers: PeerDirectory;
  localDeviceId: string;
  getReplicas: () => ReplicaModel;
  pullReplicas?: () => Promise<void>;
  claimId: string;
  ownerDeviceId: string;
  ownerThreadId: string;
  projectId: string;
  force?: boolean;
  /** Files for `projectId` (local id) from `ownerDeviceId`. Rejects when they did not arrive. */
  syncNow: (projectId: string, ownerDeviceId: string) => Promise<void>;
  newId: (prefix: string) => string;
  now: () => string;
  settingsProjectMap: (projectId: string) => string | null;
  hasProvider: (kind: string) => boolean;
  defaultProvider: { provider: string; model: string };
  importThread(event: import("@wooky/contracts").PendingEvent): void;
  /** Waits between release retries. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
  releaseAttempts?: number;
};

type StepResult = { ok: true } | { ok: false; reason: string };

function prepareImport(
  params: ClaimStepParams,
  localProjectId: string,
): { ok: true; event: PendingEvent } | { ok: false; reason: string } {
  const replicas = params.getReplicas();
  const { turns, thread } = historyFromReplica(
    replicas,
    params.ownerDeviceId,
    params.ownerThreadId,
  );
  const source = thread ?? replicas.replicas[params.ownerDeviceId]?.threads[params.ownerThreadId];
  if (!source) return { ok: false, reason: "Thread replica not found yet. Try again after sync." };

  let provider = source.provider;
  let model = source.model;
  if (!params.hasProvider(provider)) {
    provider = params.defaultProvider.provider as typeof source.provider;
    model = params.defaultProvider.model;
  }
  const at = params.now();
  return {
    ok: true,
    event: {
      type: "thread.imported",
      commandId: `import:${params.claimId}`,
      thread: {
        id: params.newId("thread"),
        projectId: localProjectId,
        title: importTitle(source.title),
        provider,
        model: model.slice(0, 200) || params.defaultProvider.model,
        // A peer's runtime mode is never trusted: an imported thread always asks first.
        runtimeMode: "approve",
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
      transcript: transcriptForImport(replicas, params.ownerDeviceId, params.ownerThreadId),
      historyTurns: validateHistoryTurns(turns),
      claimId: params.claimId,
    },
  };
}

function releaseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Release failed";
  if (message === "Connection closed") return "The owner is offline.";
  return message.slice(0, MAX_REASON);
}

function fileSyncFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Files did not sync.";
  return message.slice(0, MAX_REASON);
}

const isRunningRefusal = (error: unknown) =>
  error instanceof Error && /running turn/.test(error.message);
const isAlreadyReleased = (error: unknown) =>
  error instanceof Error && /already released/.test(error.message);

/**
 * Asks the owner to release the thread. Without `force` a running turn refuses. With `force`
 * the owner is first asked to stop the turn, and the release is sent again only once the
 * turn ended, so the owner never gives away a thread while a turn still runs.
 */
async function releaseOnOwner(
  params: ClaimStepParams,
  peerBase: { baseUrl: string; token: string },
) {
  const sleep = params.sleep ?? realSleep;
  let sent = 0;
  const send = (force: boolean) => {
    sent += 1;
    return remoteDispatch(peerBase.baseUrl, peerBase.token, {
      commandId: sent === 1 ? `release:${params.claimId}` : `release:${params.claimId}:${sent}`,
      type: "thread.release",
      threadId: params.ownerThreadId,
      toDeviceId: params.localDeviceId,
      ...(force ? { force: true } : {}),
    });
  };
  const releasedToUs = async () => {
    try {
      await params.pullReplicas?.();
    } catch {
      return false;
    }
    const thread =
      params.getReplicas().replicas[params.ownerDeviceId]?.threads[params.ownerThreadId];
    return thread?.movedTo?.deviceId === params.localDeviceId;
  };
  const settle = async (error: unknown): Promise<StepResult | "retry"> => {
    if (isRunningRefusal(error)) return "retry";
    if (isAlreadyReleased(error) && (await releasedToUs())) return { ok: true };
    return { ok: false, reason: releaseFailure(error) };
  };

  try {
    await send(false);
    return { ok: true } as StepResult;
  } catch (error) {
    const outcome = await settle(error);
    if (outcome !== "retry") return outcome;
  }
  if (!params.force) return { ok: false, reason: "The owner is still working on that thread." };

  try {
    await send(true);
  } catch (error) {
    const outcome = await settle(error);
    if (outcome !== "retry") return outcome;
  }
  const attempts = params.releaseAttempts ?? RELEASE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(RELEASE_DELAY_MS);
    try {
      await send(false);
      return { ok: true } as StepResult;
    } catch (error) {
      const outcome = await settle(error);
      if (outcome !== "retry") return outcome;
    }
  }
  return { ok: false, reason: "The owner did not stop the running turn in time." };
}

export async function executeClaimStep(params: ClaimStepParams): Promise<StepResult> {
  const localProjectId = params.settingsProjectMap(params.projectId) ?? params.projectId;
  if (!params.store.model.projects[localProjectId])
    return { ok: false, reason: "This project is not mapped on this device." };
  // Already imported or failed: a second run of the same claim must not import again.
  if (!params.store.model.pendingClaims?.[params.claimId]) return { ok: true };

  const releasedCheckpoint = params.store.isClaimReleased(params.claimId);
  const ownerThread =
    params.getReplicas().replicas[params.ownerDeviceId]?.threads[params.ownerThreadId];
  if (ownerThread?.movedTo && ownerThread.movedTo.deviceId !== params.localDeviceId) {
    return { ok: false, reason: "The owner already released this thread to another device." };
  }
  const alreadyReleasedToUs =
    releasedCheckpoint || ownerThread?.movedTo?.deviceId === params.localDeviceId;

  // Build the import before giving the thread away, so a release is never wasted.
  const prepared = prepareImport(params, localProjectId);
  if (!prepared.ok) return prepared;

  if (!alreadyReleasedToUs) {
    const peer = params.peers.get(params.ownerDeviceId);
    if (!peer) return { ok: false, reason: "The owner device is not paired." };
    const syncFiles = async (): Promise<StepResult> => {
      try {
        await params.syncNow(localProjectId, params.ownerDeviceId);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: fileSyncFailure(error) };
      }
    };
    // First, so a claim that cannot get the files stops before the owner gives anything away.
    const before = await syncFiles();
    if (!before.ok) return before;
    const released = await releaseOnOwner(params, peer);
    if (!released.ok) return released;
    params.store.markClaimReleased(params.claimId);
    // The owner has stopped (a forced release interrupts its turn), so this pull has its final
    // files. A failure leaves the release in place: the claim can be run again.
    const after = await syncFiles();
    if (!after.ok) {
      return {
        ok: false,
        reason: `${after.reason} The owner already released the thread to this device, so claim it again to continue.`,
      };
    }
    try {
      await params.pullReplicas?.();
    } catch {
      // The pre-release copy is enough to import from.
    }
  } else if (!releasedCheckpoint) {
    params.store.markClaimReleased(params.claimId);
  }

  const refreshed = prepareImport(params, localProjectId);
  const event = refreshed.ok ? refreshed.event : prepared.event;
  if (!params.store.model.pendingClaims?.[params.claimId]) return { ok: true };
  try {
    params.importThread(event);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Import failed" };
  }
  params.store.clearClaimReleased(params.claimId);
  return { ok: true };
}
