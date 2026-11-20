import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcResponse, WOOKY_WS_PATH } from "@wooky/contracts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { tempDir } from "../testing.ts";
import { createPeers } from "./peers.ts";

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
});

async function boot(label: string) {
  const home = await tempDir(label);
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    portExplicit: true,
    adapters: [createDemoAdapter({ stepMs: 0 })],
  });
  servers.push(server);
  return { home, server };
}

function rpc(server: RunningServer) {
  const socket = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
  sockets.push(socket);
  const pending = new Map<number, (response: RpcResponse) => void>();
  let nextId = 0;
  socket.on("message", (data) => {
    const message = JSON.parse(String(data)) as { id?: unknown };
    if (typeof message.id !== "number") return;
    const response = RpcResponse.parse(message);
    pending.get(response.id)?.(response);
  });
  return new Promise<{ call(method: string, params?: unknown): Promise<RpcResponse> }>(
    (resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        resolve({
          call(method, params = {}) {
            const id = ++nextId;
            return new Promise((done) => {
              pending.set(id, done);
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        });
      });
    },
  );
}

describe("remote join", () => {
  it("pairs two servers and closes the guest socket when the host revokes it", async () => {
    const a = await boot("join-a");
    const b = await boot("join-b");
    const host = await rpc(b.server);
    const created = await host.call("remote.pairingCode.create");
    if (!created.ok) throw new Error("code was not created");
    const code = (created.result as { code: string }).code;

    const guest = await rpc(a.server);
    const joined = await guest.call("remote.join", {
      connection: { kind: "direct", url: b.server.url },
      code,
      label: "Host",
    });
    if (!joined.ok) throw new Error("join failed");
    const environmentId = (joined.result as { environment: { id: string } }).environment.id;

    const info = await guest.call("remote.connectInfo", { environmentId });
    if (!info.ok) throw new Error("connectInfo failed");
    const { wsUrl, token } = info.result as { wsUrl: string; token: string };
    expect(wsUrl).toBe(`${b.server.url.replace("http", "ws")}/ws`);

    const stored = JSON.parse(readFileSync(join(a.home, "peers.json"), "utf8")) as {
      peers: Array<{ token: string }>;
    };
    expect(stored.peers[0]?.token).toBe(token);
    expect(readFileSync(join(a.home, "peers.json"), "utf8")).toContain(token);

    const remote = new WebSocket(wsUrl, [`wooky.token.${token}`]);
    sockets.push(remote);
    await new Promise((resolve, reject) => {
      remote.once("open", resolve);
      remote.once("error", reject);
    });
    expect(remote.protocol).toBe(`wooky.token.${token}`);
    const snapshot = await new Promise<{ ok?: boolean }>((resolve) => {
      remote.once("message", (data) => resolve(JSON.parse(String(data)) as { ok?: boolean }));
      remote.send(JSON.stringify({ id: 1, method: "snapshot", params: {} }));
    });
    expect(snapshot.ok).toBe(true);

    const closed = new Promise<void>((resolve) => remote.once("close", () => resolve()));
    const devices = await host.call("remote.devices.list");
    if (!devices.ok) throw new Error("device list failed");
    const deviceId = (devices.result as Array<{ deviceId: string }>)[0]?.deviceId;
    expect(deviceId).toBeTruthy();
    const revoked = await host.call("remote.devices.revoke", { deviceId });
    expect(revoked).toMatchObject({ ok: true, result: { ok: true } });
    await closed;

    const dropped = await guest.call("settings.put", { settings: { environments: [] } });
    expect(dropped.ok).toBe(true);
    const after = JSON.parse(readFileSync(join(a.home, "peers.json"), "utf8")) as {
      peers: unknown[];
    };
    expect(after.peers).toEqual([]);
  });
});

describe("remote join hardening", () => {
  const stubs: Server[] = [];
  afterEach(async () => {
    for (const stub of stubs.splice(0)) {
      stub.closeAllConnections();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
    const stub = createServer(handler);
    stubs.push(stub);
    return new Promise((resolve) => stub.listen(0, "127.0.0.1", () => resolve(stub)));
  }

  async function peersFor(home: string, joinTimeoutMs?: number) {
    return createPeers({
      home,
      deviceInfo: () => ({
        deviceId: "33333333-3333-4333-8333-333333333333",
        name: "Guest",
        platform: "other",
        version: "0.0.0",
      }),
      getSettings: () => ({ environments: [] }) as never,
      putSettings: () => ({}) as never,
      ...(joinTimeoutMs ? { joinTimeoutMs } : {}),
    });
  }

  it("does not follow a redirect, so the code never reaches another host", async () => {
    let followed = 0;
    const target = await listen((_req, res) => {
      followed += 1;
      res.end("{}");
    });
    const redirector = await listen((_req, res) => {
      res.writeHead(307, {
        location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/pair`,
      });
      res.end();
    });
    const peers = await peersFor(await tempDir("join-redirect"));
    await expect(
      peers.join({
        connection: {
          kind: "direct",
          url: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`,
        },
        code: "23456789",
      }),
    ).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/redirect/) });
    expect(followed).toBe(0);
  });

  it("gives up when the remote does not answer", async () => {
    const silent = await listen(() => {});
    const peers = await peersFor(await tempDir("join-timeout"), 100);
    await expect(
      peers.join({
        connection: {
          kind: "direct",
          url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
        },
        code: "23456789",
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/did not answer/),
    });
  });
});
