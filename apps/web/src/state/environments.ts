import type {
  DeviceInfo,
  DeviceSettings,
  Environment,
  DeviceSettingsPatch,
  PairedDeviceView,
  RpcResult,
  SyncStatus,
  SyncPush,
  TailscaleStatus,
} from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { useSyncExternalStore } from "react";
import type { ConnectionStatus } from "../rpc/client.ts";
import { backend } from "./backend.ts";
import { receiveSnapshot, useStore } from "./store.ts";
import { loadDeviceSettings } from "./appearance.ts";

export const LOCAL_ENVIRONMENT_ID = "local";

export interface EnvironmentSession {
  id: string;
  label: string;
  remote: boolean;
  unreachable: boolean;
}

export type ProbeState = "unknown" | "pending" | "open" | "offline";

interface Transport {
  reconnect(url: string, token: string | null): void;
  localUrl(): string;
}

interface EnvironmentSnapshot {
  session: EnvironmentSession;
  device: DeviceInfo | null;
  tailscale: TailscaleStatus | null;
  /** The machines this client knows, kept from the local server while another one is open. */
  environments: Environment[];
  /** Cached copy of the local server's machine list, used while a remote is open. */
  localEnvironments: Environment[];
  devices: PairedDeviceView[];
  syncStatus: SyncStatus | null;
  probes: Record<string, ProbeState>;
}

const listeners = new Set<() => void>();

let transport: Transport | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Connect info comes from the local server. A remote server cannot hand out the next machine's token. */
const connectInfoCache = new Map<string, RpcResult<"remote.connectInfo">>();
let snapshot: EnvironmentSnapshot = {
  session: {
    id: LOCAL_ENVIRONMENT_ID,
    label: "This Mac",
    remote: false,
    unreachable: false,
  },
  device: null,
  tailscale: null,
  environments: [],
  localEnvironments: [],
  devices: [],
  syncStatus: null,
  probes: {},
};

function emit(patch: Partial<EnvironmentSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function bindTransport(next: Transport) {
  transport = next;
}

export function useEnvironmentSession(): EnvironmentSession {
  return useSyncExternalStore(subscribe, () => snapshot.session);
}

export function useEnvironments(): Environment[] {
  return useSyncExternalStore(subscribe, () =>
    snapshot.session.remote ? snapshot.localEnvironments : snapshot.environments,
  );
}

export function currentEnvironments(): Environment[] {
  return snapshot.session.remote ? snapshot.localEnvironments : snapshot.environments;
}

export function useDeviceInfo(): DeviceInfo | null {
  return useSyncExternalStore(subscribe, () => snapshot.device);
}

export function useTailscale(): TailscaleStatus | null {
  return useSyncExternalStore(subscribe, () => snapshot.tailscale);
}

export function usePairedDevices(): PairedDeviceView[] {
  return useSyncExternalStore(subscribe, () => snapshot.devices);
}

export function useSyncStatus(): SyncStatus | null {
  return useSyncExternalStore(subscribe, () => snapshot.syncStatus);
}

export function useProbe(id: string): ProbeState {
  const session = useEnvironmentSession();
  const status = useStore((state) => state.status);
  const probes = useSyncExternalStore(subscribe, () => snapshot.probes);
  if (id === session.id) {
    if (status === "open") return "open";
    if (status === "offline") return "offline";
    return "pending";
  }
  return probes[id] ?? "unknown";
}

function storageKey(deviceId: string) {
  return `wooky.environment.${deviceId}`;
}

export function rememberEnvironment(deviceId: string, environmentId: string) {
  try {
    localStorage.setItem(storageKey(deviceId), environmentId);
  } catch {
    /* private mode or a full disk */
  }
}

export function rememberedEnvironment(deviceId: string): string | null {
  try {
    return localStorage.getItem(storageKey(deviceId));
  } catch {
    return null;
  }
}

export function noteConnectionStatus(status: ConnectionStatus) {
  if (!snapshot.session.remote) return;
  const unreachable = status === "reconnecting" || status === "offline";
  if (unreachable === snapshot.session.unreachable) return;
  emit({ session: { ...snapshot.session, unreachable } });
}

/** Status pushes refresh the Sync section. Snapshot and conflict pushes belong to the history UI. */
export function noteSyncPush(push: SyncPush) {
  if (push.kind !== "status") return;
  emit({
    syncStatus: { enabled: push.enabled, peers: push.peers, conflicts: push.conflicts },
  });
}

export async function putSettings(patch: DeviceSettingsPatch): Promise<boolean> {
  try {
    const settings = await backend().call("settings.put", { settings: patch });
    const previous = useStore.getState().deviceSettings;
    useStore.setState({
      deviceSettings:
        snapshot.session.remote && previous
          ? { ...settings, environments: previous.environments }
          : settings,
    });
    return true;
  } catch (error) {
    useStore.setState({
      notice: error instanceof Error ? error.message : "Could not save settings.",
    });
    return false;
  }
}

export async function refreshDevice() {
  const info = await backend().call("device.info", {});
  const session = snapshot.session;
  emit({
    device: info,
    session: session.remote ? session : { ...session, label: info.name },
  });
}

export async function renameDevice(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed === snapshot.device?.name) return;
  const info = await backend().call("device.rename", { name: trimmed });
  const session = snapshot.session;
  emit({
    device: info,
    session: session.remote ? session : { ...session, label: info.name },
  });
}

export async function refreshTailscale() {
  emit({ tailscale: await backend().call("remote.tailscaleStatus", {}) });
}

export async function refreshPaired() {
  emit({ devices: await backend().call("remote.devices.list", {}) });
}

export async function renamePaired(deviceId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const view = await backend().call("remote.devices.rename", { deviceId, name: trimmed });
  emit({
    devices: snapshot.devices.map((device) => (device.deviceId === deviceId ? view : device)),
  });
}

export async function revokePaired(deviceId: string) {
  await backend().call("remote.devices.revoke", { deviceId });
  emit({
    devices: snapshot.devices.map((device) =>
      device.deviceId === deviceId ? { ...device, revoked: true } : device,
    ),
  });
}

export async function refreshSyncStatus() {
  emit({ syncStatus: await backend().call("sync.status", {}) });
}

function syncEnvironmentsFromStore(settings: DeviceSettings | null) {
  if (snapshot.session.remote || !settings) return;
  if (
    settings.environments === snapshot.environments &&
    settings.environments === snapshot.localEnvironments
  )
    return;
  emit({ environments: settings.environments, localEnvironments: settings.environments });
}

// The switcher list belongs to this client's own server. A remote server's settings never replace it.
useStore.subscribe((state) => syncEnvironmentsFromStore(state.deviceSettings));

export async function bootEnvironments() {
  syncEnvironmentsFromStore(useStore.getState().deviceSettings);
  try {
    await refreshDevice();
  } catch (error) {
    console.error("Wooky: device info failed", error);
    return;
  }
  const deviceId = snapshot.device?.deviceId;
  if (!deviceId) return;
  const remembered = rememberedEnvironment(deviceId);
  if (remembered && remembered !== LOCAL_ENVIRONMENT_ID) await switchEnvironment(remembered);
}

function clearRetry() {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(id: string) {
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (snapshot.session.id === id && snapshot.session.unreachable) void connectRemote(id, false);
  }, 2000);
}

async function resetModel() {
  useStore.setState({ model: emptyReadModel(), selectedThreadId: null, status: "connecting" });
  if (!useStore.getState().fixture) return;
  const model = await backend().call("snapshot", {});
  receiveSnapshot(model);
  useStore.setState({ status: "open" });
}

async function connectInfoFor(id: string): Promise<RpcResult<"remote.connectInfo"> | null> {
  if (!snapshot.session.remote) {
    const info = await backend().call("remote.connectInfo", { environmentId: id });
    connectInfoCache.set(id, info);
    return info;
  }
  return connectInfoCache.get(id) ?? null;
}

async function connectRemote(id: string, reset: boolean) {
  const env = snapshot.environments.find((entry) => entry.id === id);
  const label = env?.label ?? snapshot.session.label;
  const info = await connectInfoFor(id).catch(() => null);
  if (!info && !reset) {
    // A retry: the remote session is already shown as unreachable.
    emit({ session: { id, label, remote: true, unreachable: true } });
    scheduleRetry(id);
    return;
  }
  if (!info) {
    if (snapshot.session.remote && !connectInfoCache.has(id)) {
      useStore.setState({ notice: `Switch to ${localLabel()} first to open ${label}.` });
      return;
    }
    emit({ session: { id, label, remote: true, unreachable: true } });
    useStore.setState({ model: emptyReadModel(), selectedThreadId: null, status: "reconnecting" });
    scheduleRetry(id);
    return;
  }
  emit({ session: { id, label, remote: true, unreachable: false } });
  if (reset) await resetModel();
  if (useStore.getState().fixture) {
    if (!reset) await resetModel();
    await loadDeviceSettings();
    return;
  }
  transport?.reconnect(info.wsUrl, info.token);
  const ok = await waitForOpen(10000);
  if (!ok) {
    useStore.setState({ notice: `Could not reach ${label}.` });
    return;
  }
  await loadDeviceSettings();
}

function localLabel() {
  return snapshot.device?.name ?? "this Mac";
}

async function waitForOpen(timeoutMs: number): Promise<boolean> {
  if (useStore.getState().status === "open") return true;
  return new Promise((resolve) => {
    let done = false;
    const unsubscribe = useStore.subscribe((state) => {
      if (done) return;
      if (state.status === "open") {
        done = true;
        unsubscribe();
        resolve(true);
      }
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve(false);
    }, timeoutMs);
  });
}

export async function switchEnvironment(id: string) {
  clearRetry();
  if (id === snapshot.session.id) return;
  const deviceId = snapshot.device?.deviceId;
  if (id === LOCAL_ENVIRONMENT_ID) {
    if (deviceId) rememberEnvironment(deviceId, id);
    emit({
      session: {
        id: LOCAL_ENVIRONMENT_ID,
        label: localLabel(),
        remote: false,
        unreachable: false,
      },
    });
    await resetModel();
    if (!useStore.getState().fixture) {
      transport?.reconnect(transport.localUrl(), null);
      const ok = await waitForOpen(10000);
      if (!ok) {
        useStore.setState({ notice: "Could not reach This Mac." });
        return;
      }
    }
    await loadDeviceSettings();
    syncEnvironmentsFromStore(useStore.getState().deviceSettings);
    return;
  }
  if (deviceId) rememberEnvironment(deviceId, id);
  await connectRemote(id, true);
}

export async function probeEnvironments() {
  const environments = snapshot.environments;
  const probes = { ...snapshot.probes };
  for (const environment of environments) {
    if (environment.id !== snapshot.session.id) probes[environment.id] = "pending";
  }
  emit({ probes: { ...probes } });
  await Promise.all(
    environments.map(async (environment) => {
      if (environment.id === snapshot.session.id) return;
      try {
        const info = await connectInfoFor(environment.id);
        if (!info) {
          probes[environment.id] = "unknown";
          return;
        }
        probes[environment.id] = useStore.getState().fixture
          ? "open"
          : await pingSocket(info.wsUrl, info.token);
      } catch {
        probes[environment.id] = "offline";
      }
    }),
  );
  emit({ probes: { ...probes } });
}

function pingSocket(url: string, token: string): Promise<ProbeState> {
  if (typeof WebSocket === "undefined") return Promise.resolve("unknown");
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;
    const finish = (state: ProbeState) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* the socket may already be closed */
      }
      resolve(state);
    };
    try {
      socket = new WebSocket(url, [`wooky.token.${token}`]);
    } catch {
      resolve("offline");
      return;
    }
    timer = setTimeout(() => finish("offline"), 2000);
    socket.addEventListener("open", () => finish("open"));
    socket.addEventListener("error", () => finish("offline"));
  });
}
