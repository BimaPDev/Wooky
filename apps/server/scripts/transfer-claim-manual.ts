/**
 * Manual proof: two scratch servers on 47191/47192, claim journey via RPC.
 * Run: node --experimental-strip-types apps/server/scripts/transfer-claim-manual.ts
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpcCall } from "../src/cli/rpc-client.ts";
import { createDemoAdapter } from "../src/providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { createFakeGit } from "../src/testing.ts";
import { tokenAsDeviceAuth, type PeerDirectory } from "../src/transfer/types.ts";
import { readFileSync } from "node:fs";

const PORT_A = 47191;
const PORT_B = 47192;

function deviceId(home: string): string {
  return (JSON.parse(readFileSync(join(home, "device.json"), "utf8")) as { deviceId: string })
    .deviceId;
}

async function waitIdle(url: string, threadId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snap = await rpcCall(url, "snapshot", {});
    if (snap.threads[threadId]?.status === "idle") return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error("timeout");
}

async function main() {
  const tokens = new Map<string, string>();
  const auth = tokenAsDeviceAuth(tokens);
  const links = { aUrl: "", bUrl: "", deviceA: "", deviceB: "" };
  const peersForA: PeerDirectory = {
    list: () =>
      links.bUrl
        ? [{ deviceId: links.deviceB, name: "B", baseUrl: links.bUrl, token: "token-a" }]
        : [],
    get: (id) => peersForA.list().find((p) => p.deviceId === id),
  };
  const peersForB: PeerDirectory = {
    list: () =>
      links.aUrl
        ? [{ deviceId: links.deviceA, name: "A", baseUrl: links.aUrl, token: "token-b" }]
        : [],
    get: (id) => peersForB.list().find((p) => p.deviceId === id),
  };

  const rootA = await mkdtemp(join(tmpdir(), "wooky-manual-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "wooky-manual-b-"));
  const homeA = await mkdtemp(join(tmpdir(), "wooky-manual-home-a-"));
  const homeB = await mkdtemp(join(tmpdir(), "wooky-manual-home-b-"));

  let serverA: RunningServer;
  let serverB: RunningServer;
  try {
    serverA = await startServer({
      home: homeA,
      host: "127.0.0.1",
      port: PORT_A,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
      transfer: { authenticate: auth, peers: peersForA },
    });
    links.aUrl = serverA.url;
    links.deviceA = deviceId(homeA);
    tokens.set("token-a", links.deviceA);

    serverB = await startServer({
      home: homeB,
      host: "127.0.0.1",
      port: PORT_B,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
      transfer: { authenticate: auth, peers: peersForB },
    });
    links.bUrl = serverB.url;
    links.deviceB = deviceId(homeB);
    tokens.set("token-b", links.deviceB);

    const lines: string[] = [];
    const log = (step: string) => {
      lines.push(step);
      console.info(step);
    };

    log(`A ${serverA.url} device ${links.deviceA}`);
    log(`B ${serverB.url} device ${links.deviceB}`);

    const sync = {
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
      settings: { sync: { ...sync, peers: [links.deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...sync, peers: [links.deviceA] } },
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
    log(`Owner thread ${threadA}`);

    await rpcCall(serverA.url, "dispatch", {
      commandId: "turn-1",
      type: "turn.start",
      threadId: threadA,
      prompt: "First manual turn",
    });
    await waitIdle(serverA.url, threadA);
    await rpcCall(serverA.url, "dispatch", {
      commandId: "turn-2",
      type: "turn.start",
      threadId: threadA,
      prompt: "Second manual turn",
    });
    await waitIdle(serverA.url, threadA);
    log("Owner finished two turns");

    await rpcCall(serverB.url, "sync.now", {});
    const replicas = await rpcCall(serverB.url, "sync.replicas", {});
    log(`B replicas turns: ${replicas.replicas[links.deviceA]?.turns[threadA]?.length ?? 0}`);

    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-1",
      type: "thread.claim",
      ownerDeviceId: links.deviceA,
      ownerThreadId: threadA,
      projectId: projectIdA,
    });
    let snapB = await rpcCall(serverB.url, "snapshot", {});
    for (let i = 0; i < 500; i++) {
      const imported = Object.values(snapB.threads).find((t) => t.movedFrom?.threadId === threadA);
      if (imported) {
        log(
          `B imported ${imported.id} with ${snapB.turns[imported.id]?.length ?? 0} history turns`,
        );
        break;
      }
      await new Promise<void>((r) => setImmediate(r));
      snapB = await rpcCall(serverB.url, "snapshot", {});
    }

    const snapA = await rpcCall(serverA.url, "snapshot", {});
    log(`A movedTo ${snapA.threads[threadA]?.movedTo?.deviceId ?? "none"}`);

    console.info("\n--- transcript ---");
    for (const line of lines) console.info(line);
  } finally {
    await serverA?.close();
    await serverB?.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
