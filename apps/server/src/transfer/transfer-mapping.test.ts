// wooky-allow child-process: test fixture builds real git repos
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WOOKY_WS_PATH } from "@wooky/contracts";
import { WebSocket } from "ws";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { createFakeGit } from "../testing.ts";

const servers: RunningServer[] = [];
const fakes: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const fake of fakes.splice(0)) await new Promise((done) => fake.close(done));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(prefix = "wooky-mapping-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function boot(): Promise<RunningServer> {
  const server = await startServer({
    home: await temp(),
    host: "127.0.0.1",
    port: 0,
    portExplicit: true,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    git: createFakeGit().git,
  });
  servers.push(server);
  return server;
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: "ignore",
  });

async function repo(parent: string, name: string, remote: string | null): Promise<string> {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  gitIn(root, "init", "-q");
  if (remote) gitIn(root, "remote", "add", "origin", remote);
  return root;
}

async function pairServers(a: RunningServer, b: RunningServer) {
  const codeA = await rpcCall(a.url, "remote.pairingCode.create", {});
  const joinedA = await rpcCall(b.url, "remote.join", {
    connection: { kind: "direct", url: a.url },
    code: codeA.code,
    label: "Work Mac",
  });
  const codeB = await rpcCall(b.url, "remote.pairingCode.create", {});
  const joinedB = await rpcCall(a.url, "remote.join", {
    connection: { kind: "direct", url: b.url },
    code: codeB.code,
    label: "Home PC",
  });
  return { deviceA: joinedA.host.deviceId, deviceB: joinedB.host.deviceId };
}

const syncOn = {
  enabled: true,
  categories: { files: true, threads: true, settings: false, themes: false, ignoredFiles: false },
};

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** One RPC as a paired device would send it: the token as a websocket subprotocol. */
function pairedRpc(serverUrl: string, token: string, method: string, params: object) {
  const url = new URL(serverUrl);
  url.protocol = "ws:";
  url.pathname = WOOKY_WS_PATH;
  const ws = new WebSocket(url, `wooky.token.${token}`);
  return new Promise<{ ok: boolean; error?: { message?: string } }>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; ok?: boolean; error?: never };
      if (message.id !== 1) return;
      ws.close();
      resolve(message as { ok: boolean; error?: { message?: string } });
    });
  });
}

describe("continue on this device from the receiving device", () => {
  it("maps by the same remote with one click and then the claim succeeds", async () => {
    const parent = await temp();
    const serverA = await boot();
    const serverB = await boot();
    const { deviceA, deviceB } = await pairServers(serverA, serverB);
    await rpcCall(serverA.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: [deviceB] } },
    });
    await rpcCall(serverB.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: [deviceA] } },
    });

    // The same repository on both machines: different folders, remotes spelled differently,
    // and one of them carries credentials that must never travel.
    const rootA = await repo(
      join(parent, "mac"),
      "billing-work",
      "https://deploy:s3cret@GitHub.com/Acme/Billing.git",
    );
    const rootB = await repo(join(parent, "pc"), "home-billing", "git@github.com:acme/billing");
    writeFileSync(join(rootA, "from-a.txt"), "files from the owner\n");

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
    const projectIdA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).projects)[0] ?? "";
    const projectIdB = Object.keys((await rpcCall(serverB.url, "snapshot", {})).projects)[0] ?? "";
    await rpcCall(serverA.url, "dispatch", {
      commandId: "thread",
      type: "thread.create",
      projectId: projectIdA,
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: false,
    });
    const threadA = Object.keys((await rpcCall(serverA.url, "snapshot", {})).threads)[0] ?? "";
    await rpcCall(serverA.url, "dispatch", {
      commandId: "turn",
      type: "turn.start",
      threadId: threadA,
      prompt: "Hello",
    });
    await until(async () => {
      const snap = await rpcCall(serverA.url, "snapshot", {});
      return snap.threads[threadA]?.status === "idle" ? true : undefined;
    }, "the owner's turn");

    // Nothing is mapped on B. The peer is not errored; its project is listed and a match offered.
    await rpcCall(serverB.url, "sync.now", {});
    const status = await rpcCall(serverB.url, "sync.status", {});
    const peer = status.peers.find((entry) => entry.deviceId === deviceA);
    expect(peer?.state).toBe("idle");
    expect(peer?.error).toBeNull();
    expect(peer?.name).toBe("Work Mac");
    const listed = peer?.projects.find((project) => project.id === projectIdA);
    expect(listed).toMatchObject({
      folder: "billing-work",
      remote: "github.com/acme/billing",
      mappedTo: null,
      suggestion: { projectId: projectIdB, by: "remote" },
    });
    expect(JSON.stringify(status)).not.toContain("s3cret");
    expect(existsSync(join(rootB, "from-a.txt"))).toBe(false);

    // One click: the suggested local project, keyed by the peer's project id.
    await rpcCall(serverB.url, "sync.projects.map", {
      sharedId: listed?.sharedId ?? "",
      localProjectId: listed?.suggestion?.projectId ?? null,
    });
    const settings = await rpcCall(serverB.url, "settings.get", {});
    const model = await rpcCall(serverB.url, "snapshot", {});
    expect(settings.sync.projectMap).toEqual({
      [projectIdA]: { [deviceB]: model.projects[projectIdB]?.root },
    });
    const after = (await rpcCall(serverB.url, "sync.status", {})).peers.find(
      (entry) => entry.deviceId === deviceA,
    );
    expect(after?.projects[0]).toMatchObject({ mappedTo: projectIdB, suggestion: null });

    // The claim the web banner would send: the local project the mapping points at.
    await rpcCall(serverB.url, "sync.now", {});
    await rpcCall(serverB.url, "dispatch", {
      commandId: "claim",
      type: "thread.claim",
      ownerDeviceId: deviceA,
      ownerThreadId: threadA,
      projectId: projectIdB,
    });
    const imported = await until(async () => {
      const snap = await rpcCall(serverB.url, "snapshot", {});
      const found = Object.values(snap.threads).find((t) => t.movedFrom?.threadId === threadA);
      const failed = Object.values(snap.pendingClaims).length === 0 && !found;
      if (failed) throw new Error("the claim failed");
      return found;
    }, "the claim to land");
    expect(imported.projectId).toBe(projectIdB);
    expect(readFileSync(join(rootB, "from-a.txt"), "utf8")).toBe("files from the owner\n");
    expect((await rpcCall(serverA.url, "snapshot", {})).threads[threadA]?.movedTo?.deviceId).toBe(
      deviceB,
    );
  }, 60_000);

  it("only this machine maps projects, and only to projects registered here", async () => {
    const parent = await temp();
    const server = await boot();
    const { code } = await rpcCall(server.url, "remote.pairingCode.create", {});
    const response = await fetch(new URL("/pair", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        device: { deviceId: "dev-x", name: "x", platform: "other", version: "0.0.0" },
      }),
    });
    const { token } = (await response.json()) as { token: string };
    const root = await repo(parent, "mine", null);
    await rpcCall(server.url, "dispatch", { commandId: "add", type: "project.add", root });
    const projectId = Object.keys((await rpcCall(server.url, "snapshot", {})).projects)[0] ?? "";

    // A paired device is refused.
    const refused = await pairedRpc(server.url, token, "sync.projects.map", {
      sharedId: "p",
      localProjectId: projectId,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toMatch(/only be changed on this machine/);
    // An id that is not a registered project is refused, and so is a shared id that is not an id.
    await expect(
      rpcCall(server.url, "sync.projects.map", { sharedId: "p", localProjectId: "../../etc" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      rpcCall(server.url, "sync.projects.map", {
        sharedId: "../../etc",
        localProjectId: projectId,
      }),
    ).rejects.toThrow(/not a project id/);
    await expect(
      rpcCall(server.url, "sync.projects.map", {
        sharedId: "__proto__",
        localProjectId: projectId,
      }),
    ).rejects.toThrow(/not a project id/);
    expect((await rpcCall(server.url, "settings.get", {})).sync.projectMap).toEqual({});
  });
});

describe("a hostile peer", () => {
  it("cannot make this device write outside its registered projects", async () => {
    const parent = await temp();
    const canary = await temp("wooky-canary-");
    const server = await boot();
    const root = await repo(parent, "local", "https://example.com/acme/local.git");
    writeFileSync(join(root, "mine.txt"), "mine\n");
    await rpcCall(server.url, "dispatch", { commandId: "add", type: "project.add", root });
    const localId = Object.keys((await rpcCall(server.url, "snapshot", {})).projects)[0] ?? "";

    const hostile = [
      // a real-looking entry, with everything attacker-controlled stretched
      {
        id: "p1",
        sharedId: "p1",
        name: "x".repeat(50_000),
        folder: "local",
        remote: "https://u:p@example.com/acme/local.git",
        branch: "main",
      },
      // a path where a folder name belongs
      { id: "p2", sharedId: "p2", name: "n", folder: canary, remote: null, branch: null },
      { id: "p3", sharedId: "../../etc", name: "n", folder: "x", remote: null, branch: null },
      { id: "p4", sharedId: "__proto__", name: "n", folder: "x", remote: null, branch: null },
      { id: "p5", sharedId: "p5", name: "n", folder: "..\\..\\x", remote: null, branch: null },
      "not an object",
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `bulk-${index}`,
        sharedId: `bulk-${index}`,
        name: "bulk",
        folder: "bulk",
        remote: null,
        branch: null,
      })),
    ];
    const fake = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/pair")
        return send(200, {
          token: "hostile-token",
          host: { deviceId: "evil", name: "Evil", platform: "other", version: "0.0.0" },
        });
      if (req.url?.startsWith("/sync/projects")) return send(200, { projects: hostile });
      if (req.url?.startsWith("/sync/tips"))
        return send(200, [{ projectId: "p2", tip: "a".repeat(40) }]);
      if (req.url?.startsWith("/sync/bundle")) return send(404, {});
      return send(200, { events: [], nextSince: 0 });
    });
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    fakes.push(fake);
    const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    await rpcCall(server.url, "remote.join", {
      connection: { kind: "direct", url: base },
      code: "ABCDEFGH",
    });
    await rpcCall(server.url, "settings.put", {
      settings: { sync: { ...syncOn, peers: ["evil"] } },
    });
    await rpcCall(server.url, "sync.now", {});

    const peer = (await rpcCall(server.url, "sync.status", {})).peers.find(
      (entry) => entry.deviceId === "evil",
    );
    // Only well-formed, size-capped entries survive; nothing malformed is listed.
    const ids = (peer?.projects ?? []).map((project) => project.id);
    expect(ids).not.toContain("p2");
    expect(ids).not.toContain("p3");
    expect(ids).not.toContain("p4");
    expect(ids).not.toContain("p5");
    expect(ids).toContain("p1");
    expect(ids).toContain("bulk-0");
    expect(ids.length).toBeLessThanOrEqual(200);
    expect(peer?.projects.every((project) => project.name.length <= 200)).toBe(true);
    // Its remote came with credentials; they are gone, and it is only ever compared, never fetched.
    const first = peer?.projects.find((project) => project.id === "p1");
    expect(first?.remote).toBe("example.com/acme/local");
    expect(first?.name).toHaveLength(200);
    expect(first?.suggestion).toEqual({ projectId: localId, by: "remote" });
    // Nothing was mapped, nothing was written anywhere but the project's own files.
    expect((await rpcCall(server.url, "settings.get", {})).sync.projectMap).toEqual({});
    expect(readdirSync(canary)).toEqual([]);
    expect(
      readdirSync(root)
        .filter((name) => name !== ".git")
        .sort(),
    ).toEqual(["mine.txt"]);
    expect(existsSync(join(parent, "etc"))).toBe(false);
  }, 60_000);
});
