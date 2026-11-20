import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WOOKY_WS_PATH, type AgeEvent, type SyncStatus } from "@wooky/contracts";
import { WebSocket } from "ws";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { createFakeGit } from "../testing.ts";
import { createClaimFileSync, problemsFor, type ClaimSyncEngine } from "./file-sync.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "wooky-claim-files-"));
  dirs.push(dir);
  return dir;
};

const syncOn = (peers: string[]) => ({
  enabled: true,
  intervalSec: 3600,
  categories: { files: true, threads: true, settings: false, themes: false, ignoredFiles: false },
  peers,
});

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function readEvents(serverUrl: string): Promise<AgeEvent[]> {
  const url = new URL(serverUrl);
  url.protocol = "ws:";
  url.pathname = WOOKY_WS_PATH;
  const ws = new WebSocket(url);
  const events: AgeEvent[] = [];
  return new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(JSON.stringify({ id: 1, method: "subscribe", params: { fromSeq: 0 } })),
    );
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; push?: string; event?: AgeEvent };
      if (message.push === "event" && message.event) events.push(message.event);
      if (message.id === 1) {
        ws.close();
        resolve(events);
      }
    });
  });
}

describe("claim waits for the file sync before it imports", () => {
  /** Device A owns a thread in a project holding `notes.txt`; B maps the project to its folder. */
  async function setup(bOptions: { fileSyncTimeoutMs?: number } = {}) {
    const [homeA, homeB, rootA, rootB] = [
      await tempDir(),
      await tempDir(),
      await tempDir(),
      await tempDir(),
    ];
    await mkdir(join(rootA, "src"), { recursive: true });
    await writeFile(join(rootA, "notes.txt"), "from device A\n");
    await writeFile(join(rootA, "src", "a.ts"), "export const a = 1;\n");

    const boot = async (home: string, transfer?: { fileSyncTimeoutMs?: number }) => {
      const server = await startServer({
        home,
        host: "127.0.0.1",
        port: 0,
        portExplicit: true,
        adapters: [createDemoAdapter({ stepMs: 0 })],
        git: createFakeGit().git,
        ...(transfer ? { transfer } : {}),
      });
      servers.push(server);
      return server;
    };
    const serverA = await boot(homeA);
    const serverB = await boot(homeB, bOptions);

    const codeA = await rpcCall(serverA.url, "remote.pairingCode.create", {});
    const joinedA = await rpcCall(serverB.url, "remote.join", {
      connection: { kind: "direct", url: serverA.url },
      code: codeA.code,
      label: "Device A",
    });
    const codeB = await rpcCall(serverB.url, "remote.pairingCode.create", {});
    const joinedB = await rpcCall(serverA.url, "remote.join", {
      connection: { kind: "direct", url: serverB.url },
      code: codeB.code,
      label: "Device B",
    });
    const deviceA = joinedA.host.deviceId;
    const deviceB = joinedB.host.deviceId;

    await rpcCall(serverA.url, "dispatch", {
      commandId: "add-a",
      type: "project.add",
      root: rootA,
    });
    const projectA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).projects)[0] ?? "";
    await rpcCall(serverB.url, "dispatch", {
      commandId: "add-b",
      type: "project.add",
      root: rootB,
    });
    await rpcCall(serverA.url, "settings.put", {
      settings: { sync: syncOn([deviceB]) },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: {
        sync: { ...syncOn([deviceA]), projectMap: { [projectA]: { [deviceB]: rootB } } },
      },
    });

    await rpcCall(serverA.url, "dispatch", {
      commandId: "create-t",
      type: "thread.create",
      projectId: projectA,
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: false,
    });
    const threadA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).threads)[0] ?? "";
    await rpcCall(serverA.url, "dispatch", {
      commandId: "turn-1",
      type: "turn.start",
      threadId: threadA,
      prompt: "First",
    });
    // The turn's end snapshots the project; wait until A has something to offer.
    await until(async () => {
      const snap = await rpcCall(serverA.url, "snapshot", {});
      if (snap.threads[threadA]?.status !== "idle" || (snap.turns[threadA]?.length ?? 0) === 0)
        return undefined;
      const list = await rpcCall(serverA.url, "sync.snapshots.list", { projectId: projectA });
      return list.length > 0 ? true : undefined;
    }, "A's turn snapshot");
    return { serverA, serverB, deviceA, deviceB, projectA, threadA, rootB };
  }

  it("pulls the owner's files, then imports the thread", async () => {
    const { serverA, serverB, deviceA, projectA, threadA, rootB } = await setup();

    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-1",
      type: "thread.claim",
      ownerDeviceId: deviceA,
      ownerThreadId: threadA,
      projectId: projectA,
    });
    const imported = await until(async () => {
      const snap = await rpcCall(serverB.url, "snapshot", {});
      return Object.values(snap.threads).find((thread) => thread.movedFrom?.threadId === threadA);
    }, "the imported thread");
    expect(imported.movedFrom?.deviceId).toBe(deviceA);

    // The files were there by the time the thread was imported (B started with none).
    expect(await readFile(join(rootB, "notes.txt"), "utf8")).toBe("from device A\n");
    expect(await readFile(join(rootB, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    const snapA = await rpcCall(serverA.url, "snapshot", {});
    expect(snapA.threads[threadA]?.movedTo).not.toBeNull();
  }, 60_000);

  it("says so and stops when the files did not arrive in time", async () => {
    const { serverA, serverB, deviceA, projectA, threadA } = await setup({
      fileSyncTimeoutMs: 1,
    });

    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-slow",
      type: "thread.claim",
      ownerDeviceId: deviceA,
      ownerThreadId: threadA,
      projectId: projectA,
    });
    const failed = await until(async () => {
      const events = await readEvents(serverB.url);
      return events.find((event) => event.type === "thread.claimFailed");
    }, "the claim to fail");
    if (failed.type !== "thread.claimFailed") throw new Error("unreachable");
    expect(failed.reason).toMatch(/did not finish syncing within 1 ms, so the claim was stopped/);

    // Nothing was imported, and the owner kept its thread: the claim stopped before releasing.
    const snapB = await rpcCall(serverB.url, "snapshot", {});
    expect(Object.values(snapB.threads).some((thread) => thread.movedFrom)).toBe(false);
    const snapA = await rpcCall(serverA.url, "snapshot", {});
    expect(snapA.threads[threadA]?.movedTo ?? null).toBeNull();
  }, 60_000);
});

describe("createClaimFileSync", () => {
  const settings = (sync: Partial<ReturnType<typeof syncOn>> = {}) => ({
    sync: {
      ...syncOn(["owner"]),
      projectMap: {},
      retention: { keepDays: 30, keepMin: 50 },
      ...sync,
    },
  });
  const status = (peer: Partial<SyncStatus["peers"][number]> | null): SyncStatus => ({
    enabled: true,
    conflicts: [],
    peers: peer
      ? [
          {
            deviceId: "owner",
            name: "Owner",
            state: "idle",
            lastSyncAt: null,
            error: null,
            ...peer,
          },
        ]
      : [],
  });
  const engineWith = (peer: Parameters<typeof status>[0], now?: () => Promise<{ ok: true }>) => {
    const calls: Array<string | undefined> = [];
    const engine: ClaimSyncEngine = {
      now: (projectId) => {
        calls.push(projectId);
        return now ? now() : Promise.resolve({ ok: true });
      },
      status: () => status(peer),
    };
    return { engine, calls };
  };

  it("does nothing when file sync is off", async () => {
    const { engine, calls } = engineWith(null);
    for (const sync of [
      { enabled: false },
      {
        categories: {
          files: false,
          threads: true,
          settings: false,
          themes: false,
          ignoredFiles: false,
        },
      },
    ]) {
      await createClaimFileSync({ settings: () => settings(sync), engine })("p1", "owner");
    }
    expect(calls).toEqual([]);
  });

  it("syncs the project and returns when the owner delivered", async () => {
    const { engine, calls } = engineWith({ state: "idle" });
    await createClaimFileSync({ settings: () => settings(), engine })("p1", "owner");
    expect(calls).toEqual(["p1"]);
  });

  it("gives up after the bound with a message that names the owner", async () => {
    const { engine } = engineWith({ state: "syncing" }, () => new Promise(() => {}));
    const fired: Array<() => void> = [];
    const sync = createClaimFileSync({
      settings: () => settings(),
      engine,
      peerName: () => "Studio PC",
      setTimeout: (fn, ms) => {
        expect(ms).toBe(30_000);
        fired.push(fn);
        return fired.length;
      },
      clearTimeout: () => {},
    });
    const result = sync("p1", "owner");
    await Promise.resolve();
    fired[0]?.();
    await expect(result).rejects.toThrow(
      /Files from Studio PC did not finish syncing within 30 seconds, so the claim was stopped/,
    );
  });

  it("reports an offline owner and a failing project, but not an unrelated unmapped one", async () => {
    await expect(
      createClaimFileSync({
        settings: () => settings(),
        engine: engineWith({ state: "offline", error: "connect ECONNREFUSED" }).engine,
        peerName: () => "Owner",
      })("p1", "owner"),
    ).rejects.toThrow(/Owner could not be reached.*ECONNREFUSED/s);
    await expect(
      createClaimFileSync({
        settings: () => settings(),
        engine: engineWith({ state: "error", error: "p1: The bundle is too large." }).engine,
        peerName: () => "Owner",
      })("p1", "owner"),
    ).rejects.toThrow(/Files from Owner did not sync: p1: The bundle is too large\./);
    await createClaimFileSync({
      settings: () => settings(),
      engine: engineWith({
        state: "error",
        error: "other: project not mapped on this device; p2: broke",
      }).engine,
    })("p1", "owner");
    await expect(
      createClaimFileSync({ settings: () => settings(), engine: engineWith(null).engine })(
        "p1",
        "stranger",
      ),
    ).rejects.toThrow(/not a file sync peer/);
  });

  it("keeps only the problems that belong to the project", () => {
    expect(
      problemsFor(
        "a: project not mapped on this device; p1: broke; p2: broke; The peer rejected this device's token.",
        "p1",
      ),
    ).toEqual(["p1: broke", "The peer rejected this device's token."]);
  });
});
