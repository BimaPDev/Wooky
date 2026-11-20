import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SyncSettings, type SyncPush } from "@wooky/contracts";
import { createSyncEngine, type SyncEngine } from "./engine.ts";
import { createSyncRoutes } from "./http.ts";
import type { PeerRecord as PeerEntry } from "../remote/peers.ts";
import type { SyncProject, SyncTimers } from "./types.ts";

const cleanups: Array<() => Promise<void>> = [];

export async function cleanupSyncTests(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()?.();
}

export async function tempDir(prefix = "wooky-sync-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** Narrows a value a test just proved exists. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value.");
  return value;
}

export const read = (root: string, path: string) => readFile(join(root, path), "utf8");

export function fakeTimers() {
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: SyncTimers = {
    setInterval: (fn, ms) => {
      intervals.set(next, { fn, ms });
      return next++;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
    setTimeout: (fn, ms) => {
      timeouts.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (handle) => void timeouts.delete(handle as number),
  };
  return { timers, intervals, timeouts };
}

export interface Device {
  deviceId: string;
  home: string;
  root: string;
  projectId: string;
  engine: SyncEngine;
  settings: { sync: SyncSettings };
  /** The device's registered projects; tests add to it. */
  projects: SyncProject[];
  running: Set<string>;
  pushes: SyncPush[];
  notices: string[];
  peers: PeerEntry[];
  server: Server | null;
  url: string;
  clock: { time: number };
  timers: ReturnType<typeof fakeTimers>;
  /** Who a request carrying the right token authenticates as. */
  auth: { caller: string | null };
}

export interface DeviceOptions {
  deviceId: string;
  projectId?: string;
  /** The project's display name. Defaults to the id. */
  name?: string;
  /** Normalized git remote and branch the project reports to peers. Default: none. */
  remote?: string | null;
  branch?: string | null;
  root?: string;
  home?: string;
  sync?: Partial<SyncSettings>;
  maxFileBytes?: number;
  maxApplyBytes?: number;
  gitBin?: string;
  /** Replaces the default "is this project in the running set" check. */
  turnRunning?: (projectId: string) => boolean;
  token?: string;
}

/** One device: an engine, a project folder, an HTTP server for its /sync routes. */
export async function makeDevice(options: DeviceOptions): Promise<Device> {
  const root = options.root ?? (await tempDir(`wooky-${options.deviceId}-`));
  const home = options.home ?? (await tempDir(`wooky-home-${options.deviceId}-`));
  const projectId = options.projectId ?? `proj-${options.deviceId}`;
  const settings = { sync: SyncSettings.parse({ enabled: true, ...options.sync }) };
  const running = new Set<string>();
  const pushes: SyncPush[] = [];
  const notices: string[] = [];
  const peers: PeerEntry[] = [];
  const clock = { time: Date.parse("2026-01-01T00:00:00Z") };
  const timers = fakeTimers();
  const projects: SyncProject[] = [{ id: projectId, name: options.name ?? projectId, root }];
  const engine = createSyncEngine({
    home,
    deviceId: options.deviceId,
    settings: () => settings,
    projects: () => projects,
    turnRunning: options.turnRunning ?? ((id) => running.has(id)),
    peers: { list: () => peers, get: (id) => peers.find((peer) => peer.deviceId === id) },
    now: () => new Date((clock.time += 1000)),
    timers: timers.timers,
    notice: (_project, message) => notices.push(message),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.maxApplyBytes === undefined ? {} : { maxApplyBytes: options.maxApplyBytes }),
    ...(options.gitBin ? { gitBin: options.gitBin } : {}),
    projectFacts: async () => ({ remote: options.remote ?? null, branch: options.branch ?? null }),
  });
  engine.onPush((push) => pushes.push(push));
  cleanups.push(() => engine.stop());

  const token = options.token ?? "secret";
  const auth: Device["auth"] = { caller: null };
  const routes = createSyncRoutes(engine, (req) => {
    if (req.headers.authorization !== `Bearer ${token}`) return null;
    return auth.caller === null ? null : { deviceId: auth.caller };
  });
  const server = createServer((req, res) => {
    if (!routes(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    deviceId: options.deviceId,
    home,
    root,
    projectId,
    engine,
    settings,
    projects,
    running,
    pushes,
    notices,
    peers,
    server,
    url,
    clock,
    timers,
    auth,
  };
}

/** Makes `a` and `b` peers: each knows the other and maps the project to its own folder. */
export function pair(a: Device, b: Device, token = "secret"): void {
  const sharedId = a.projectId;
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    self.auth.caller = other.deviceId;
    self.peers.push({ deviceId: other.deviceId, name: other.deviceId, baseUrl: other.url, token });
    self.settings.sync = SyncSettings.parse({
      ...self.settings.sync,
      peers: [...self.settings.sync.peers, other.deviceId],
      projectMap: {
        [sharedId]: { [a.deviceId]: a.root, [b.deviceId]: b.root },
      },
    });
  }
}
