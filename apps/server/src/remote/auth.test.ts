import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RpcResponse, WOOKY_WS_PATH } from "@wooky/contracts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import type { Tailscale } from "./tailscale.ts";
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

function fakeTailscale() {
  const calls: string[] = [];
  const tailscale: Tailscale = {
    status: async () => ({ installed: true, running: true, hostName: "box.ts.net", ips: [] }),
    serve: async (port) => {
      calls.push(`serve ${port}`);
    },
    serveOff: async () => {
      calls.push("off");
    },
    reportServeError: () => {},
  };
  return { calls, tailscale };
}

async function boot(extra: { tailscale?: Tailscale } = {}) {
  const home = await tempDir("auth");
  const server = await startServer({
    ...extra,
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

  it("keeps everything that decides what the host runs or exposes off paired devices", async () => {
    const server = await boot();
    const token = await pair(server);
    const authed = await openRemote(server, { protocols: [`wooky.token.${token}`] });
    const denied = async (method: string, params: unknown = {}) => {
      const reply = (await callRaw(authed, method, params)) as { error?: { code: string } };
      return reply.error?.code;
    };
    expect(await denied("providers.signIn", { provider: "claude" })).toBe("forbidden");
    expect(await denied("fs.pickFolder", {})).toBe("forbidden");
    expect(await denied("remote.pairingCode.create")).toBe("forbidden");
    expect(await denied("remote.connectInfo", { environmentId: "x" })).toBe("forbidden");
    expect(
      await denied("remote.join", {
        connection: { kind: "direct", url: "http://127.0.0.1:1" },
        code: "23456789",
      }),
    ).toBe("forbidden");
    const blocked = [
      { providers: { claude: { binaryPath: "/tmp/evil" } } },
      { providers: { claude: { extraArgs: ["--dangerous"] } } },
      { providers: { claude: { env: { PATH: "/tmp" } } } },
      {
        acpAgents: [{ id: "a", name: "A", command: "/tmp/evil", args: [], env: {}, enabled: true }],
      },
      { environments: [] },
      { sync: { enabled: true } },
    ];
    for (const settings of blocked) {
      expect(await denied("settings.put", { settings })).toBe("forbidden");
    }
    // Ordinary preferences stay open to a paired device.
    const colour = (await callRaw(authed, "settings.put", {
      settings: { colorMode: "dark" },
    })) as { ok: boolean };
    expect(colour.ok).toBe(true);

    const local = await rpc(server);
    const providers = await local.call("settings.put", {
      settings: { providers: { claude: { extraArgs: ["--verbose"] } } },
    });
    expect(providers.ok).toBe(true);
  });

  it("rejects a token that was presented but is wrong, even from loopback", async () => {
    const server = await boot();
    const bad = "not-a-real-token";
    expect(
      (await fetch(`${server.url}/healthz`, { headers: { authorization: `Bearer ${bad}` } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${server.url}/healthz`, { headers: { authorization: "Bearer" } })).status,
    ).toBe(401);
    // A browser cookie is not a deliberate presentation, so a stale one does not lock the UI out.
    expect(
      (await fetch(`${server.url}/healthz`, { headers: { cookie: `wooky_token=${bad}` } })).status,
    ).toBe(200);
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);

    const refused = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(wsUrl(server), [`wooky.token.${bad}`]);
      sockets.push(socket);
      socket.once("open", () => reject(new Error("upgrade was accepted")));
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("error", () => {});
    });
    expect(refused).toBe(401);
  });

  it("never treats a proxied request as local", async () => {
    const server = await boot();
    for (const headers of [
      { "x-forwarded-for": "203.0.113.9" },
      { forwarded: "for=203.0.113.9" },
      { "tailscale-user-login": "a@example.com" },
    ]) {
      expect((await fetch(`${server.url}/healthz`, { headers })).status).toBe(401);
    }
    const token = await pair(server);
    expect(
      (
        await fetch(`${server.url}/healthz`, {
          headers: { "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  });

  it("serves Tailscale from its own listener that always needs a device token", async () => {
    const { calls, tailscale } = fakeTailscale();
    const server = await boot({ tailscale });
    expect(server.servePort()).toBeNull();
    const token = await pair(server);
    const local = await rpc(server);
    const enabled = await local.call("settings.put", {
      settings: { hosting: { enabled: true, tailscaleServe: true } },
    });
    expect(enabled.ok).toBe(true);
    const port = server.servePort();
    expect(port).not.toBeNull();
    expect(port).not.toBe(server.port);
    expect(calls).toEqual([`serve ${port}`]);

    const base = `http://127.0.0.1:${port}`;
    // Loopback does not make a Serve request local: no token, no data.
    expect((await fetch(`${base}/healthz`)).status).toBe(401);
    expect(
      (await fetch(`${base}/healthz`, { headers: { cookie: "wooky_token=stale" } })).status,
    ).toBe(401);
    expect((await fetch(`${base}/pair`)).status).toBe(200);
    // The UI shell is public, so a browser can load it and then pair.
    expect((await fetch(`${base}/`)).status).not.toBe(401);
    expect(
      (await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);

    const unauthenticated = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${WOOKY_WS_PATH}`);
      sockets.push(socket);
      socket.once("open", () => reject(new Error("upgrade was accepted")));
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("error", () => {});
    });
    expect(unauthenticated).toBe(401);

    const viaServe = new WebSocket(`ws://127.0.0.1:${port}${WOOKY_WS_PATH}`, [
      `wooky.token.${token}`,
    ]);
    sockets.push(viaServe);
    await new Promise((resolve, reject) => viaServe.once("open", resolve).once("error", reject));
    const reply = (await callRaw(viaServe, "remote.devices.list")) as {
      error?: { code: string };
    };
    expect(reply.error?.code).toBe("forbidden");

    const disabled = await local.call("settings.put", {
      settings: { hosting: { tailscaleServe: false } },
    });
    expect(disabled.ok).toBe(true);
    expect(server.servePort()).toBeNull();
    expect(calls).toEqual([`serve ${port}`, "off"]);
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
