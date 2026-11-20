import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WOOKY_WS_PATH, type AgeEvent } from "@wooky/contracts";
import { WebSocket } from "ws";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { createFakeGit } from "../testing.ts";
import { remoteDispatch } from "./remote-rpc.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wooky-transfer-sec-"));
  dirs.push(dir);
  return dir;
}

async function boot(sleep?: (ms: number) => Promise<void>): Promise<RunningServer> {
  const server = await startServer({
    home: await tempRoot(),
    host: "127.0.0.1",
    port: 0,
    portExplicit: true,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    git: createFakeGit().git,
    ...(sleep ? { transfer: { sleep, releaseAttempts: 5_000 } } : {}),
  });
  servers.push(server);
  return server;
}

/** The real pairing flow: a code from the host, redeemed over POST /pair. */
async function pairDevice(host: RunningServer, deviceId: string): Promise<string> {
  const { code } = await rpcCall(host.url, "remote.pairingCode.create", {});
  const response = await fetch(new URL("/pair", host.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      device: { deviceId, name: deviceId, platform: "other", version: "0.0.0" },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function pairServers(a: RunningServer, b: RunningServer) {
  const codeA = await rpcCall(a.url, "remote.pairingCode.create", {});
  const joinedA = await rpcCall(b.url, "remote.join", {
    connection: { kind: "direct", url: a.url },
    code: codeA.code,
    label: "Device A",
  });
  const codeB = await rpcCall(b.url, "remote.pairingCode.create", {});
  const joinedB = await rpcCall(a.url, "remote.join", {
    connection: { kind: "direct", url: b.url },
    code: codeB.code,
    label: "Device B",
  });
  return { deviceA: joinedA.host.deviceId, deviceB: joinedB.host.deviceId };
}

const syncOn = {
  enabled: true,
  categories: { files: true, threads: true, settings: false, themes: false, ignoredFiles: false },
};

/** Replays the whole event log over a subscription; the replay lands before the reply. */
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

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("transfer endpoints authenticate with the real device auth", () => {
  it("rejects missing, bad and revoked tokens, and devices that are not sync peers", async () => {
    const host = await boot();
    const token = await pairDevice(host, "dev-peer");
    const stranger = await pairDevice(host, "dev-stranger");
    await rpcCall(host.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: ["dev-peer"] } },
    });

    const get = (path: string, headers: Record<string, string>) =>
      fetch(new URL(path, host.url), { headers });
    // A proxy header makes the request remote, so loopback gives it no trust.
    const remote = { "x-forwarded-for": "100.64.0.9" };

    for (const path of ["/sync/threads?since=0", "/sync/settings", "/sync/themes"]) {
      expect((await get(path, remote)).status).toBe(401);
      expect((await get(path, { ...remote, authorization: "Bearer nope" })).status).toBe(401);
      expect((await get(path, { ...remote, authorization: `Bearer ${stranger}` })).status).toBe(
        403,
      );
    }
    const ok = await get("/sync/threads?since=0", {
      ...remote,
      authorization: `Bearer ${token}`,
    });
    expect(ok.status).toBe(200);

    await rpcCall(host.url, "remote.devices.revoke", { deviceId: "dev-peer" });
    expect(
      (await get("/sync/threads?since=0", { ...remote, authorization: `Bearer ${token}` })).status,
    ).toBe(401);
    await expect(
      remoteDispatch(host.url, token, {
        commandId: "r-revoked",
        type: "thread.release",
        threadId: "x",
        toDeviceId: "dev-peer",
      }),
    ).rejects.toThrow(/401|Unauthorized|closed|Unexpected server response/i);
  });
});

describe("transfer commands from a paired device", () => {
  it("cannot release as another device, nor claim or import", async () => {
    const host = await boot();
    const token = await pairDevice(host, "dev-b");
    await rpcCall(host.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: ["dev-b"] } },
    });

    await expect(
      remoteDispatch(host.url, token, {
        commandId: "as-other",
        type: "thread.release",
        threadId: "t",
        toDeviceId: "dev-c",
      }),
    ).rejects.toThrow(/only release a thread to itself/);
    await expect(
      remoteDispatch(host.url, token, {
        commandId: "claim-remote",
        type: "thread.claim",
        ownerDeviceId: "dev-c",
        ownerThreadId: "t",
        projectId: "p",
      }),
    ).rejects.toThrow(/only be claimed on this machine/);
    await expect(
      remoteDispatch(host.url, token, {
        commandId: "import-remote",
        type: "thread.import",
        sourceDeviceId: "dev-c",
        sourceThreadId: "t",
        projectId: "p",
        title: "x",
        provider: "demo",
        model: "demo",
        transcript: "hi",
      }),
    ).rejects.toThrow(/only be claimed on this machine/);
    // Naming itself passes the guard and then meets the normal not-found check.
    await expect(
      remoteDispatch(host.url, token, {
        commandId: "as-self",
        type: "thread.release",
        threadId: "missing",
        toDeviceId: "dev-b",
      }),
    ).rejects.toThrow(/not found|No thread|missing/i);
  });

  it("is not a sync peer unless the owner listed it", async () => {
    const host = await boot();
    const token = await pairDevice(host, "dev-b");
    await expect(
      remoteDispatch(host.url, token, {
        commandId: "not-peer",
        type: "thread.release",
        threadId: "t",
        toDeviceId: "dev-b",
      }),
    ).rejects.toThrow(/not a thread sync peer/);
  });
});

describe("claiming a thread whose turn is running", () => {
  it("refuses, then releases only after the turn was interrupted", async () => {
    const serverA = await boot();
    const serverB = await boot(() => new Promise<void>((resolve) => setImmediate(resolve)));
    const { deviceA, deviceB } = await pairServers(serverA, serverB);
    await rpcCall(serverA.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: [deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: [deviceA] } },
    });

    const rootA = await tempRoot();
    const rootB = await tempRoot();
    await rpcCall(serverA.url, "dispatch", {
      commandId: "add-a",
      type: "project.add",
      root: rootA,
    });
    await rpcCall(serverB.url, "dispatch", {
      commandId: "add-b",
      type: "project.add",
      root: rootB,
    });
    const projectA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).projects)[0] ?? "";
    const projectB = Object.keys((await rpcCall(serverB.url, "snapshot", {})).projects)[0] ?? "";
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { projectMap: { [projectA]: { [deviceB]: projectB } } } },
    });

    await rpcCall(serverA.url, "dispatch", {
      commandId: "mk",
      type: "thread.create",
      projectId: projectA,
      provider: "demo",
      model: "demo",
      runtimeMode: "approve",
      isolate: false,
    });
    const threadA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).threads)[0] ?? "";
    // Approve mode parks the demo turn on an approval, so it stays running until interrupted.
    await rpcCall(serverA.url, "dispatch", {
      commandId: "t1",
      type: "turn.start",
      threadId: threadA,
      prompt: "Long job",
    });
    await until(async () => {
      const snap = await rpcCall(serverA.url, "snapshot", {});
      return snap.threads[threadA]?.status === "waiting" ? true : undefined;
    }, "the turn to wait for approval");
    await rpcCall(serverB.url, "sync.now", {});

    // 1. Without force the owner refuses and nothing moves.
    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-plain",
      type: "thread.claim",
      ownerDeviceId: deviceA,
      ownerThreadId: threadA,
      projectId: projectA,
    });
    const refusal = await until(async () => {
      const events = await readEvents(serverB.url);
      return events.find((event) => event.type === "thread.claimFailed");
    }, "the plain claim to fail");
    expect(refusal.type === "thread.claimFailed" && refusal.reason).toMatch(/still working/);
    let snapB = await rpcCall(serverB.url, "snapshot", {});
    expect(Object.values(snapB.threads).filter((item) => item.movedFrom)).toEqual([]);
    expect(snapB.pendingClaims).toEqual({});
    let snapA = await rpcCall(serverA.url, "snapshot", {});
    expect(snapA.threads[threadA]?.movedTo).toBeNull();
    expect(snapA.threads[threadA]?.status).toBe("waiting");

    // 2. With force the owner interrupts first and releases once the turn ended.
    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-force",
      type: "thread.claim",
      ownerDeviceId: deviceA,
      ownerThreadId: threadA,
      projectId: projectA,
      force: true,
    });
    const imported = await until(async () => {
      const snap = await rpcCall(serverB.url, "snapshot", {});
      return Object.values(snap.threads).find((item) => item.movedFrom?.threadId === threadA);
    }, "the forced claim to import");
    snapB = await rpcCall(serverB.url, "snapshot", {});
    expect(snapB.turns[imported.id]?.map((turn) => turn.status)).toEqual(["interrupted"]);
    expect(imported.runtimeMode).toBe("approve");

    snapA = await rpcCall(serverA.url, "snapshot", {});
    expect(snapA.threads[threadA]?.movedTo?.deviceId).toBe(deviceB);
    const aEvents = await readEvents(serverA.url);
    const finished = aEvents.findIndex(
      (event) => event.type === "turn.finished" && event.status === "interrupted",
    );
    const released = aEvents.findIndex((event) => event.type === "thread.released");
    expect(finished).toBeGreaterThan(-1);
    expect(released).toBeGreaterThan(finished);
    expect(aEvents.filter((event) => event.type === "thread.released")).toHaveLength(1);

    await expect(
      rpcCall(serverA.url, "dispatch", {
        commandId: "after-move",
        type: "turn.start",
        threadId: threadA,
        prompt: "Still here?",
      }),
    ).rejects.toThrow(/moved to/);
  }, 60_000);
});
