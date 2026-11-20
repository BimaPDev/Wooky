import type { DeviceInfo, ReplicaModel, SyncPush, SyncStatus } from "@wooky/contracts";
import { create } from "zustand";
import { disambiguateNames } from "../components/anywhere/format.ts";
import { fetchReplicas } from "../rpc/anywhere-history-extra.ts";
import { backend } from "./backend.ts";
import { subscribeToEvents, useStore } from "./store.ts";

export interface ReplicaTarget {
  deviceId: string;
  threadId: string;
}

export interface Toast {
  id: number;
  text: string;
  action: { label: string; run: () => void } | null;
}

export interface AnywhereHistoryState {
  /** Null until sync.status answers; stays null while the server says `unavailable`. */
  syncStatus: SyncStatus | null;
  localDevice: DeviceInfo | null;
  replicas: ReplicaModel["replicas"];
  /** The peer thread shown read-only in the main area. */
  replicaView: ReplicaTarget | null;
  /** Project whose history panel is open. */
  historyProjectId: string | null;
  /** Bumped on a `snapshot` push so open timelines refetch. */
  snapshotTick: number;
  /** Why the last claim of a peer thread failed, by `deviceId:threadId`. */
  claimFailures: Record<string, string>;
  toast: Toast | null;
}

export const useAnywhereHistory = create<AnywhereHistoryState>(() => ({
  syncStatus: null,
  localDevice: null,
  replicas: {},
  replicaView: null,
  historyProjectId: null,
  snapshotTick: 0,
  claimFailures: {},
  toast: null,
}));

export const replicaKey = (target: ReplicaTarget) => `${target.deviceId}:${target.threadId}`;

/** claimId → replica key, for claims started from this window. */
const claimKeys = new Map<string, string>();

// sync: the event stream tells a claim that failed why; the read model keeps only pending claims
subscribeToEvents((event) => {
  if (event.type !== "thread.claimFailed") return;
  const key = claimKeys.get(event.claimId);
  if (!key) return;
  claimKeys.delete(event.claimId);
  useAnywhereHistory.setState((state) => ({
    claimFailures: { ...state.claimFailures, [key]: event.reason },
  }));
});

// sync: leaving the peer thread for anything else in the main area closes the read-only view
useStore.subscribe((state, prev) => {
  if (!useAnywhereHistory.getState().replicaView) return;
  const left =
    (state.selectedThreadId !== prev.selectedThreadId && state.selectedThreadId !== null) ||
    (state.newThread !== null && prev.newThread === null) ||
    (state.fleetBoardOpen && !prev.fleetBoardOpen) ||
    (state.compareGroupId !== null && prev.compareGroupId === null);
  if (left) useAnywhereHistory.setState({ replicaView: null });
});

export function openHistory(projectId: string) {
  useStore.setState({ paletteOpen: false });
  useAnywhereHistory.setState({ historyProjectId: projectId });
}

export const closeHistory = () => useAnywhereHistory.setState({ historyProjectId: null });

export function openReplicaThread(target: ReplicaTarget) {
  useStore.setState({
    selectedThreadId: null,
    newThread: null,
    settingsOpen: false,
    fleetBoardOpen: false,
    compareGroupId: null,
    jumpOpen: false,
  });
  useAnywhereHistory.setState({ replicaView: target });
}

export function recordClaimAttempt(target: ReplicaTarget, claimId: string) {
  const key = replicaKey(target);
  claimKeys.set(claimId, key);
  useAnywhereHistory.setState((state) => {
    const { [key]: _cleared, ...rest } = state.claimFailures;
    return { claimFailures: rest };
  });
}

let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(text: string, action: Toast["action"] = null, ms = 12_000) {
  if (toastTimer) clearTimeout(toastTimer);
  toastId += 1;
  useAnywhereHistory.setState({ toast: { id: toastId, text, action } });
  toastTimer = setTimeout(dismissToast, ms);
}

export function dismissToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  useAnywhereHistory.setState({ toast: null });
}

export async function refreshSync(): Promise<void> {
  await Promise.all([refreshStatus(), refreshReplicas(), refreshDevice()]);
}

async function refreshStatus() {
  try {
    useAnywhereHistory.setState({ syncStatus: await backend().call("sync.status", {}) });
  } catch {
    useAnywhereHistory.setState({ syncStatus: null });
  }
}

async function refreshDevice() {
  try {
    useAnywhereHistory.setState({ localDevice: await backend().call("device.info", {}) });
  } catch {
    /* the device is only needed to map projects for a claim */
  }
}

export async function refreshReplicas() {
  try {
    useAnywhereHistory.setState({ replicas: (await fetchReplicas()).replicas });
  } catch {
    /* A3 may not be on this server yet: no peer threads to show */
  }
}

let replicaTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReplicaRefresh() {
  if (replicaTimer) clearTimeout(replicaTimer);
  replicaTimer = setTimeout(() => {
    replicaTimer = null;
    void refreshReplicas();
  }, 300);
}

export function receiveSyncPush(push: SyncPush) {
  if (push.kind === "status") {
    useAnywhereHistory.setState({
      syncStatus: { enabled: push.enabled, peers: push.peers, conflicts: push.conflicts },
    });
    scheduleReplicaRefresh();
  } else if (push.kind === "conflict") {
    useAnywhereHistory.setState((state) => {
      const current = state.syncStatus ?? { enabled: true, peers: [], conflicts: [] };
      const others = current.conflicts.filter((conflict) => conflict.id !== push.conflict.id);
      return { syncStatus: { ...current, conflicts: [...others, push.conflict] } };
    });
  } else {
    useAnywhereHistory.setState((state) => ({ snapshotTick: state.snapshotTick + 1 }));
    if (push.snapshot.kind === "thread") scheduleReplicaRefresh();
  }
}

/**
 * Device id → display name, from the peers sync.status lists. The name is the label the user
 * gave the machine; two machines with the same label are told apart by their device id.
 */
export function deviceNames(status: SyncStatus | null): Record<string, string> {
  const names = disambiguateNames(
    (status?.peers ?? []).map((peer) => ({ id: peer.deviceId, name: peer.name })),
  );
  return Object.fromEntries(names);
}

export function deviceLabel(names: Record<string, string>, deviceId: string): string {
  return names[deviceId] ?? "another device";
}
