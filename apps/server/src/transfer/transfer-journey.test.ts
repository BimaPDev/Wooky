import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TurnInput } from "../providers/types.ts";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { startServer, type RunningServer } from "../server.ts";
import { createFakeGit } from "../testing.ts";
import type { PeerDirectory } from "./types.ts";
import { tokenAsDeviceAuth } from "./types.ts";

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function deviceId(home: string): string {
  return (JSON.parse(readFileSync(join(home, "device.json"), "utf8")) as { deviceId: string })
    .deviceId;
}

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

    const tokens = new Map<string, string>();
    const auth = tokenAsDeviceAuth(tokens);
    const links = { aUrl: "", bUrl: "", deviceA: "", deviceB: "" };

    const peersForA: PeerDirectory = {
      list: () =>
        links.bUrl
          ? [
              {
                deviceId: links.deviceB,
                name: "B",
                baseUrl: links.bUrl,
                token: "token-a",
              },
            ]
          : [],
      get: (id) => peersForA.list().find((peer) => peer.deviceId === id),
    };
    const peersForB: PeerDirectory = {
      list: () =>
        links.aUrl
          ? [
              {
                deviceId: links.deviceA,
                name: "A",
                baseUrl: links.aUrl,
                token: "token-b",
              },
            ]
          : [],
      get: (id) => peersForB.list().find((peer) => peer.deviceId === id),
    };

    const serverA = await startServer({
      home: homeA,
      host: "127.0.0.1",
      port: 0,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
      transfer: { authenticate: auth, peers: peersForA },
    });
    servers.push(serverA);
    links.aUrl = serverA.url;
    links.deviceA = deviceId(homeA);
    tokens.set("token-a", links.deviceA);

    const demoB = captureDemo(0);
    const serverB = await startServer({
      home: homeB,
      host: "127.0.0.1",
      port: 0,
      adapters: [demoB.adapter],
      git: createFakeGit().git,
      transfer: { authenticate: auth, peers: peersForB },
    });
    servers.push(serverB);
    links.bUrl = serverB.url;
    links.deviceB = deviceId(homeB);
    tokens.set("token-b", links.deviceB);

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
      settings: { sync: { ...syncBody, peers: [links.deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...syncBody, peers: [links.deviceA] } },
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
      settings: { sync: { projectMap: { [projectIdA]: { [links.deviceB]: projectIdB } } } },
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
    expect(replicas.replicas[links.deviceA]?.turns[threadA]?.length).toBe(2);

    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-1",
      type: "thread.claim",
      ownerDeviceId: links.deviceA,
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
      if (Object.keys(snapB.pendingClaims ?? {}).length === 0 && !imported) {
        const failed = await rpcCall(serverB.url, "snapshot", {});
        void failed;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      snapB = await rpcCall(serverB.url, "snapshot", {});
    }
    const imported = Object.values(snapB.threads).find(
      (thread) => thread.movedFrom?.threadId === threadA,
    );
    expect(imported?.movedFrom).toEqual({ deviceId: links.deviceA, threadId: threadA });
    expect(snapB.turns[imported?.id ?? ""]?.length).toBe(2);

    const snapA = await rpcCall(serverA.url, "snapshot", {});
    expect(snapA.threads[threadA]?.movedTo?.deviceId).toBe(links.deviceB);

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
});
