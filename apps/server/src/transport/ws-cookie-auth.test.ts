import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WOOKY_WS_PATH, type RpcMethod } from "@wooky/contracts";
import { WebSocket } from "ws";
import { rpcCall } from "../cli/rpc-client.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { createFakeGit } from "../testing.ts";

const servers: RunningServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  const home = await mkdtemp(join(tmpdir(), "wooky-ws-cookie-"));
  dirs.push(home);
  const server = await startServer({
    home,
    host: "127.0.0.1",
    port: 0,
    portExplicit: true,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    git: createFakeGit().git,
  });
  servers.push(server);
  return server;
}

/** The real pairing flow. Returns the token and the cookie the host sets on the device. */
async function pair(host: RunningServer, deviceId: string) {
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
  const token = ((await response.json()) as { token: string }).token;
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toBe(`wooky_token=${token}`);
  return { token, cookie };
}

interface Reply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** One websocket on /ws that sends only what `headers` carry; no bearer, no subprotocol. */
async function open(host: RunningServer, headers: Record<string, string>) {
  const url = new URL(host.url);
  url.protocol = "ws:";
  url.pathname = WOOKY_WS_PATH;
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let next = 0;
  const call = (method: RpcMethod, params: unknown) =>
    new Promise<Reply>((resolve) => {
      const id = (next += 1);
      const onMessage = (data: unknown) => {
        const message = JSON.parse(String(data)) as Reply & { id?: number };
        if (message.id !== id) return;
        ws.off("message", onMessage);
        resolve(message);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { call, close: () => ws.close() };
}

/** Compares one object, so a failure shows which call was let through. */
const forbidden = (reply: Reply, label = "") =>
  expect({ label, ok: reply.ok, code: reply.error?.code }).toEqual({
    label,
    ok: false,
    code: "forbidden",
  });

const adminCalls: Array<[RpcMethod, unknown]> = [
  ["remote.pairingCode.create", {}],
  ["remote.devices.list", {}],
  ["remote.devices.revoke", { deviceId: "dev-cookie" }],
  ["remote.devices.rename", { deviceId: "dev-cookie", name: "x" }],
  ["remote.join", { connection: { kind: "direct", url: "http://127.0.0.1:1" }, code: "ABCD2345" }],
  ["remote.connectInfo", { environmentId: "env" }],
  ["providers.signIn", { provider: "claude" }],
  ["fs.pickFolder", {}],
  ["fs.pickable", {}],
];

const launchSettings: Array<[string, unknown]> = [
  ["hosting", { hosting: { enabled: true } }],
  ["provider binaryPath", { providers: { claude: { binaryPath: "/tmp/evil" } } }],
  ["provider env", { providers: { claude: { env: { LD_PRELOAD: "/tmp/evil.so" } } } }],
  ["provider extraArgs", { providers: { claude: { extraArgs: ["--dangerous"] } } }],
  ["acpAgents", { acpAgents: [] }],
  ["sync", { sync: { enabled: true, peers: ["dev-cookie"] } }],
];

describe("a paired device that authenticates with only its cookie on /ws", () => {
  it("is not the operator: claim, import, admin RPCs and launch settings are refused", async () => {
    const host = await boot();
    const { cookie } = await pair(host, "dev-cookie");
    const conn = await open(host, { cookie });

    forbidden(
      await conn.call("dispatch", {
        commandId: "c1",
        type: "thread.claim",
        ownerDeviceId: "dev-other",
        ownerThreadId: "t1",
        projectId: "p1",
      }),
    );
    forbidden(
      await conn.call("dispatch", {
        commandId: "c2",
        type: "thread.import",
        sourceDeviceId: "dev-other",
        sourceThreadId: "t1",
        projectId: "p1",
        title: "stolen",
        provider: "demo",
        model: "demo",
        transcript: "",
      }),
    );
    for (const [method, params] of adminCalls) {
      forbidden(await conn.call(method, params), method);
    }
    for (const [label, patch] of launchSettings)
      forbidden(await conn.call("settings.put", { settings: patch }), label);

    // Nothing was partially applied, and the host was not changed.
    const settings = await rpcCall(host.url, "settings.get", {});
    expect(settings.hosting.enabled).toBe(false);
    expect(settings.sync.enabled).toBe(false);
    expect(settings.providers).toEqual({});
    expect(Object.keys((await rpcCall(host.url, "snapshot", {})).threads)).toEqual([]);

    // Reads and ordinary actions still work.
    const snapshot = await conn.call("snapshot", {});
    expect(snapshot.ok).toBe(true);
    const info = await conn.call("settings.get", {});
    expect(info.ok).toBe(true);
    const ordinary = await conn.call("settings.put", { settings: { importLocalHistory: false } });
    expect(ordinary).toMatchObject({ ok: true });
    conn.close();
  });

  it("is refused the same way as a device that sends its token explicitly", async () => {
    const host = await boot();
    const { token, cookie } = await pair(host, "dev-cookie");
    const viaCookie = await open(host, { cookie });
    const viaBearer = await open(host, { authorization: `Bearer ${token}` });
    const claim = {
      commandId: "c1",
      type: "thread.claim",
      ownerDeviceId: "dev-other",
      ownerThreadId: "t1",
      projectId: "p1",
    };
    for (const conn of [viaCookie, viaBearer]) {
      forbidden(await conn.call("dispatch", claim), "thread.claim");
      forbidden(await conn.call("remote.devices.list", {}), "remote.devices.list");
      expect(await conn.call("device.info", {})).toMatchObject({ ok: true });
    }
    viaCookie.close();
    viaBearer.close();
  });

  it("keeps the operator's own loopback client in charge", async () => {
    const host = await boot();
    const conn = await open(host, {});
    const devices = await conn.call("remote.devices.list", {});
    expect(devices).toMatchObject({ ok: true });
    const claim = await conn.call("dispatch", {
      commandId: "c1",
      type: "thread.claim",
      ownerDeviceId: "dev-other",
      ownerThreadId: "t1",
      projectId: "p1",
    });
    // Not refused for who is asking; it fails later because sync is off here.
    expect(claim.error?.code).not.toBe("forbidden");
    conn.close();
  });
});
