import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TurnInput } from "../providers/types.ts";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { startServer, type RunningServer } from "../server.ts";
import { openEventStore } from "../store/event-store.ts";
import { createFakeGit } from "../testing.ts";
import { remoteDispatch } from "./remote-rpc.ts";

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function captureDemo(stepMs = 0): { adapter: ProviderAdapter; inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  const base = createDemoAdapter({ stepMs });
  const adapter: ProviderAdapter = {
    ...base,
    runTurn(input) {
      inputs.push(input);
      return base.runTurn(input);
    },
  };
  return { adapter, inputs };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wooky-transfer-"));
}

async function pairServers(
  a: RunningServer,
  b: RunningServer,
): Promise<{ deviceA: string; deviceB: string }> {
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

async function waitThreadIdle(serverUrl: string, threadId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snap = await rpcCall(serverUrl, "snapshot", {});
    if (snap.threads[threadId]?.status === "idle") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for the thread to become idle");
}

describe("transfer journey", () => {
  it("pulls replicas, claims a thread, and handoffs on the next turn", async () => {
    const rootA = await tempRoot();
    const rootB = await tempRoot();
    const homeA = await tempRoot();
    const homeB = await tempRoot();

    const serverA = await startServer({
      home: homeA,
      host: "127.0.0.1",
      port: 0,
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
    });
    servers.push(serverA);

    const demoB = captureDemo(0);
    const serverB = await startServer({
      home: homeB,
      host: "127.0.0.1",
      port: 0,
      portExplicit: true,
      adapters: [demoB.adapter],
      git: createFakeGit().git,
    });
    servers.push(serverB);

    const { deviceA, deviceB } = await pairServers(serverA, serverB);

    const syncBody = {
      enabled: true,
      categories: {
        files: true,
        threads: true,
        settings: false,
        themes: false,
        ignoredFiles: false,
      },
    };

    await rpcCall(serverA.url, "settings.put", {
      settings: { sync: { ...syncBody, peers: [deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...syncBody, peers: [deviceA] } },
    });

    await rpcCall(serverA.url, "dispatch", {
      commandId: "add-a",
      type: "project.add",
      root: rootA,
    });
    const projectIdA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).projects)[0] ?? "";

    await rpcCall(serverB.url, "dispatch", {
      commandId: "add-b",
      type: "project.add",
      root: rootB,
    });
    const projectIdB = Object.keys((await rpcCall(serverB.url, "snapshot", {})).projects)[0] ?? "";

    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { projectMap: { [projectIdA]: { [deviceB]: projectIdB } } } },
    });

    await rpcCall(serverA.url, "dispatch", {
      commandId: "create-t",
      type: "thread.create",
      projectId: projectIdA,
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
    await waitThreadIdle(serverA.url, threadA);

    await rpcCall(serverA.url, "dispatch", {
      commandId: "turn-2",
      type: "turn.start",
      threadId: threadA,
      prompt: "Second",
    });
    await waitThreadIdle(serverA.url, threadA);

    await rpcCall(serverB.url, "sync.now", {});
    const replicas = await rpcCall(serverB.url, "sync.replicas", {});
    expect(replicas.replicas[deviceA]?.turns[threadA]?.length).toBe(2);

    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-1",
      type: "thread.claim",
      ownerDeviceId: deviceA,
      ownerThreadId: threadA,
      projectId: projectIdA,
    });

    const deadline = Date.now() + 15_000;
    let snapB = await rpcCall(serverB.url, "snapshot", {});
    while (Date.now() < deadline) {
      const imported = Object.values(snapB.threads).find(
        (thread) => thread.movedFrom?.threadId === threadA,
      );
      if (imported) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      snapB = await rpcCall(serverB.url, "snapshot", {});
    }
    const imported = Object.values(snapB.threads).find(
      (thread) => thread.movedFrom?.threadId === threadA,
    );
    expect(imported?.movedFrom).toEqual({ deviceId: deviceA, threadId: threadA });
    expect(snapB.turns[imported?.id ?? ""]?.length).toBe(2);

    const snapA = await rpcCall(serverA.url, "snapshot", {});
    expect(snapA.threads[threadA]?.movedTo?.deviceId).toBe(deviceB);

    const importedId = imported?.id ?? "";
    demoB.inputs.length = 0;
    await rpcCall(serverB.url, "dispatch", {
      commandId: "turn-b",
      type: "turn.start",
      threadId: importedId,
      prompt: "Continue here",
    });
    await waitThreadIdle(serverB.url, importedId);
    expect(demoB.inputs.some((input) => input.handoffContext?.includes("First"))).toBe(true);

    await expect(
      rpcCall(serverA.url, "dispatch", {
        commandId: "turn-a-blocked",
        type: "turn.start",
        threadId: threadA,
        prompt: "Nope",
      }),
    ).rejects.toThrow(/moved to/);

    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }, 60_000);

  it("recovers and imports after a crash between owner release and local import", async () => {
    const rootA = await tempRoot();
    const rootB = await tempRoot();
    const homeA = await tempRoot();
    const homeB = await tempRoot();

    const serverA = await startServer({
      home: homeA,
      host: "127.0.0.1",
      port: 0,
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
    });
    servers.push(serverA);

    const serverB = await startServer({
      home: homeB,
      host: "127.0.0.1",
      port: 0,
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
    });
    servers.push(serverB);

    const { deviceA, deviceB } = await pairServers(serverA, serverB);
    const syncBody = {
      enabled: true,
      categories: {
        files: true,
        threads: true,
        settings: false,
        themes: false,
        ignoredFiles: false,
      },
    };
    await rpcCall(serverA.url, "settings.put", {
      settings: { sync: { ...syncBody, peers: [deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...syncBody, peers: [deviceA] } },
    });

    await rpcCall(serverA.url, "dispatch", {
      commandId: "add-a",
      type: "project.add",
      root: rootA,
    });
    const projectIdA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).projects)[0] ?? "";

    await rpcCall(serverB.url, "dispatch", {
      commandId: "add-b",
      type: "project.add",
      root: rootB,
    });
    const projectIdB = Object.keys((await rpcCall(serverB.url, "snapshot", {})).projects)[0] ?? "";
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { projectMap: { [projectIdA]: { [deviceB]: projectIdB } } } },
    });

    await rpcCall(serverA.url, "dispatch", {
      commandId: "create-t",
      type: "thread.create",
      projectId: projectIdA,
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
      prompt: "Before crash",
    });
    await waitThreadIdle(serverA.url, threadA);

    await rpcCall(serverB.url, "sync.now", {});

    // Simulate the owner having released the thread to B, while B crashed before importing.
    const envA = (await rpcCall(serverB.url, "settings.get", {})).environments.find(
      (env) => env.deviceId === deviceA,
    );
    expect(envA).toBeDefined();
    const conn = await rpcCall(serverB.url, "remote.connectInfo", {
      environmentId: envA?.id ?? "",
    });
    await remoteDispatch(serverA.url, conn.token, {
      commandId: "release:claim-crash",
      type: "thread.release",
      threadId: threadA,
      toDeviceId: deviceB,
    });

    // Shut down B and seed its store with the pending claim (no thread.imported yet).
    await serverB.close();
    servers.splice(servers.indexOf(serverB), 1);

    const storeB = openEventStore(homeB, () => new Date().toISOString());
    storeB.commit({
      commandId: "claim-crash",
      events: [
        {
          type: "thread.claimRequested",
          commandId: "claim-crash",
          claimId: "claim-crash",
          ownerDeviceId: deviceA,
          ownerThreadId: threadA,
          projectId: projectIdA,
        },
      ],
      effects: [
        {
          kind: "claimThread",
          threadId: "claim-crash",
          claimId: "claim-crash",
          ownerDeviceId: deviceA,
          ownerThreadId: threadA,
          projectId: projectIdA,
        },
      ],
    });
    storeB.close();

    // Restart B: recovery must see A already released to B and import without failing.
    const serverB2 = await startServer({
      home: homeB,
      host: "127.0.0.1",
      port: 0,
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
    });
    servers.push(serverB2);

    const deadline = Date.now() + 15_000;
    let snapB = await rpcCall(serverB2.url, "snapshot", {});
    while (Date.now() < deadline) {
      const imported = Object.values(snapB.threads).find(
        (thread) => thread.movedFrom?.threadId === threadA,
      );
      if (imported) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      snapB = await rpcCall(serverB2.url, "snapshot", {});
    }

    const imported = Object.values(snapB.threads).find(
      (thread) => thread.movedFrom?.threadId === threadA,
    );
    expect(imported).toBeDefined();
    expect(snapB.pendingClaims).toEqual({});
    expect(snapB.turns[imported?.id ?? ""]?.length).toBe(1);

    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }, 60_000);
});
