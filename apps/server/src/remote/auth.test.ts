import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcResponse, WOOKY_WS_PATH } from "@wooky/contracts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { tempDir } from "../testing.ts";

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
});

const REMOTE = "203.0.113.20";
const device = {
  deviceId: "22222222-2222-4222-8222-222222222222",
  name: "Phone",
  platform: "other" as const,
  version: "0.0.0",
};

async function boot() {
  const home = await tempDir("auth");
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    portExplicit: true,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    remoteAddress: (req) => {
      const header = req.headers["x-wooky-remote-address"];
      if (typeof header === "string" && header.length > 0) return header;
      return req.socket.remoteAddress;
    },
  });
  servers.push(server);
  return server;
}

function wsUrl(server: RunningServer): string {
  return `${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`;
}

function rpc(server: RunningServer) {
  const socket = new WebSocket(wsUrl(server));
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

async function pair(server: RunningServer): Promise<string> {
  const client = await rpc(server);
  const created = await client.call("remote.pairingCode.create");
  if (!created.ok) throw new Error("code was not created");
  const code = (created.result as { code: string }).code;
  const response = await fetch(`${server.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device }),
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

function openRemote(
  server: RunningServer,
  options: { protocols?: string[]; headers?: Record<string, string>; origin?: string },
): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl(server), options.protocols, {
    origin: options.origin,
    headers: { "x-wooky-remote-address": REMOTE, ...options.headers },
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade ${res.statusCode}`));
    });
    socket.once("error", reject);
  });
}

function callRaw(socket: WebSocket, method: string, params: unknown = {}): Promise<unknown> {
  return new Promise((resolve) => {
    const onMessage = (data: unknown) => {
      const message = JSON.parse(String(data)) as { id?: number };
      if (message.id !== 1) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id: 1, method, params }));
  });
}

describe("remote auth", () => {
  it("accepts a bearer token, a cookie, and the websocket subprotocol", async () => {
    const server = await boot();
    const token = await pair(server);
    const remoteHeaders = { "x-wooky-remote-address": REMOTE };

    expect((await fetch(`${server.url}/healthz`, { headers: remoteHeaders })).status).toBe(401);
    expect(
      (
        await fetch(`${server.url}/healthz`, {
          headers: { ...remoteHeaders, authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${server.url}/healthz`, {
          headers: { ...remoteHeaders, cookie: `wooky_token=${token}` },
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);

    const authed = await openRemote(server, {
      protocols: [`wooky.token.${token}`],
      origin: "http://evil.example",
    });
    expect(authed.protocol).toBe(`wooky.token.${token}`);
    const snapshot = (await callRaw(authed, "snapshot")) as { ok: boolean };
    expect(snapshot.ok).toBe(true);
    const denied = (await callRaw(authed, "remote.devices.list")) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const picker = (await callRaw(authed, "fs.pickable", { query: "" })) as {
      error?: { code: string };
    };
    expect(picker.error?.code).toBe("forbidden");
    const hosting = (await callRaw(authed, "settings.put", {
      settings: { hosting: { enabled: true } },
    })) as { error?: { code: string } };
    expect(hosting.error?.code).toBe("forbidden");
  });

  it("closes the socket when the token is revoked and still checks Origin on loopback", async () => {
    const server = await boot();
    const token = await pair(server);
    const remote = await openRemote(server, { protocols: [`wooky.token.${token}`] });
    const closed = new Promise<number>((resolve) => {
      remote.once("close", (code) => resolve(code));
    });
    const local = await rpc(server);
    const revoked = await local.call("remote.devices.revoke", { deviceId: device.deviceId });
    expect(revoked).toMatchObject({ ok: true, result: { ok: true } });
    await closed;

    const rejected = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(wsUrl(server), { origin: "http://evil.example" });
      sockets.push(socket);
      socket.once("open", () => reject(new Error("upgrade was accepted")));
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("error", () => {});
    });
    expect(rejected).toBe(403);
  });
});
