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

const PORT_A = 47191;
const PORT_B = 47192;

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
  const rootA = await mkdtemp(join(tmpdir(), "wooky-manual-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "wooky-manual-b-"));
  const homeA = await mkdtemp(join(tmpdir(), "wooky-manual-home-a-"));
  const homeB = await mkdtemp(join(tmpdir(), "wooky-manual-home-b-"));

  let serverA: RunningServer | undefined;
  let serverB: RunningServer | undefined;
  try {
    serverA = await startServer({
      home: homeA,
      host: "127.0.0.1",
      port: PORT_A,
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
    });

    serverB = await startServer({
      home: homeB,
      host: "127.0.0.1",
      port: PORT_B,
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
      git: createFakeGit().git,
    });

    const codeA = await rpcCall(serverA.url, "remote.pairingCode.create", {});
    const joinedA = await rpcCall(serverB.url, "remote.join", {
      connection: { kind: "direct", url: serverA.url },
      code: codeA.code,
      label: "A",
    });
    const codeB = await rpcCall(serverB.url, "remote.pairingCode.create", {});
    const joinedB = await rpcCall(serverA.url, "remote.join", {
      connection: { kind: "direct", url: serverB.url },
      code: codeB.code,
      label: "B",
    });
    const deviceA = joinedA.host.deviceId;
    const deviceB = joinedB.host.deviceId;

    const lines: string[] = [];
    const log = (step: string) => {
      lines.push(step);
      console.info(step);
    };

    log(`A ${serverA.url} device ${deviceA}`);
    log(`B ${serverB.url} device ${deviceB}`);

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
      settings: { sync: { ...sync, peers: [deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...sync, peers: [deviceA] } },
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
    log(`B replicas turns: ${replicas.replicas[deviceA]?.turns[threadA]?.length ?? 0}`);

    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim-1",
      type: "thread.claim",
      ownerDeviceId: deviceA,
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
