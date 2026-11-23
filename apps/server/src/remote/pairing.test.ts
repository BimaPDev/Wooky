import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

const device = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  name: "Phone",
  platform: "other" as const,
  version: "0.0.0",
};

async function boot(
  now: () => number,
  remoteAddress?: (header: string | undefined) => string | undefined,
) {
  const home = await tempDir("pair");
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    portExplicit: true,
    now,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    ...(remoteAddress
      ? {
          remoteAddress: (req) => {
            const header = req.headers["x-wooky-remote-address"];
            return (
              remoteAddress(typeof header === "string" ? header : undefined) ??
              req.socket.remoteAddress
            );
          },
        }
      : {}),
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
  return new Promise<{
    call(method: string, params?: unknown): Promise<RpcResponse>;
  }>((resolve, reject) => {
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
  });
}

async function postPair(
  server: RunningServer,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("pairing", () => {
  it("creates a device file, pairs once, and never returns the token hash", async () => {
    let now = Date.parse("2026-06-01T00:00:00.000Z");
    const { home, server } = await boot(() => now);
    const stat = statSync(join(home, "device.json"));
    // Windows has no POSIX mode bits; Node reports 0o666 there.
    expect(stat.mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o600);
    const identity = JSON.parse(readFileSync(join(home, "device.json"), "utf8")) as {
      deviceId: string;
      createdAt: string;
    };
    expect(identity.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(identity.createdAt).toBe("2026-06-01T00:00:00.000Z");

    const client = await rpc(server);
    const info = await client.call("device.info");
    expect(info.ok).toBe(true);
    const renamed = await client.call("device.rename", { name: "Work Mac" });
    expect(renamed).toMatchObject({
      ok: true,
      result: { name: "Work Mac", deviceId: identity.deviceId },
    });

    const created = await client.call("remote.pairingCode.create");
    if (!created.ok) throw new Error("code was not created");
    const code = created.result as { code: string; url: string };
    expect(code.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);

    const wrong = await postPair(server, { code: "23456789", device });
    expect(wrong.status).toBe(401);

    const paired = await postPair(
      server,
      { code: code.code.toLowerCase(), device },
      { "x-forwarded-proto": "https" },
    );
    expect(paired.status).toBe(200);
    const body = (await paired.json()) as { token: string; host: { name: string } };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(body.host.name).toBe("Work Mac");
    const cookie = paired.headers.getSetCookie().join(";");
    expect(cookie).toContain(`wooky_token=${body.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");

    const again = await postPair(server, { code: code.code, device });
    expect(again.status).toBe(401);

    const listed = await client.call("remote.devices.list");
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    expect(listed).toMatchObject({
      ok: true,
      result: [{ deviceId: device.deviceId, name: "Phone", revoked: false }],
    });
    const named = await client.call("remote.devices.rename", {
      deviceId: device.deviceId,
      name: "Pocket",
    });
    expect(JSON.stringify(named)).not.toContain("tokenHash");
    expect(named).toMatchObject({ ok: true, result: { name: "Pocket" } });

    const stored = readFileSync(join(home, "paired-devices.json"), "utf8");
    expect(stored).toContain("tokenHash");
    expect(stored).not.toContain(body.token);
    expect(statSync(join(home, "paired-devices.json")).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o600,
    );

    now += 30_000;
    await fetch(`${server.url}/healthz`, { headers: { authorization: `Bearer ${body.token}` } });
    const seen = JSON.parse(readFileSync(join(home, "paired-devices.json"), "utf8")) as {
      devices: Array<{ lastSeenAt: string | null }>;
    };
    const firstSeen = seen.devices[0]?.lastSeenAt;
    now += 10_000;
    await fetch(`${server.url}/healthz`, { headers: { authorization: `Bearer ${body.token}` } });
    const seenAgain = JSON.parse(readFileSync(join(home, "paired-devices.json"), "utf8")) as {
      devices: Array<{ lastSeenAt: string | null }>;
    };
    expect(seenAgain.devices[0]?.lastSeenAt).toBe(firstSeen);
  });

  it("marks the cookie Secure when the pairing page came from HTTPS", async () => {
    const { server } = await boot(
      () => Date.parse("2026-06-01T00:00:00.000Z"),
      (header) => header,
    );
    const client = await rpc(server);
    const remote = { "x-wooky-remote-address": "203.0.113.20" };
    const codeFor = async () => {
      const created = await client.call("remote.pairingCode.create");
      if (!created.ok) throw new Error("code was not created");
      return (created.result as { code: string }).code;
    };

    const https = await postPair(
      server,
      { code: await codeFor(), device },
      {
        ...remote,
        origin: "https://wooky.example",
      },
    );
    expect(https.status).toBe(200);
    expect(https.headers.getSetCookie().join(";")).toContain("Secure");

    const http = await postPair(
      server,
      { code: await codeFor(), device },
      {
        ...remote,
        origin: "http://wooky.example",
      },
    );
    expect(http.status).toBe(200);
    expect(http.headers.getSetCookie().join(";")).not.toContain("Secure");
  });

  it("expires a code when the clock passes ten minutes", async () => {
    let now = Date.parse("2026-06-01T00:00:00.000Z");
    const { server } = await boot(() => now);
    const client = await rpc(server);
    const created = await client.call("remote.pairingCode.create");
    if (!created.ok) throw new Error("code was not created");
    const code = (created.result as { code: string }).code;
    now += 10 * 60 * 1000;
    expect((await postPair(server, { code, device })).status).toBe(401);
  });

  it("locks only the failing address, and doubles the lock on a repeat offence", async () => {
    let now = Date.parse("2026-06-01T00:00:00.000Z");
    const { server } = await boot(
      () => now,
      (header) => header,
    );
    const client = await rpc(server);
    const created = await client.call("remote.pairingCode.create");
    if (!created.ok) throw new Error("code was not created");
    const code = (created.result as { code: string }).code;
    const from = (address: string) => ({ "x-wooky-remote-address": address });
    const bad = { code: "23456789", device };
    for (let i = 0; i < 4; i += 1) {
      expect((await postPair(server, bad, from("203.0.113.10"))).status).toBe(401);
    }
    expect((await postPair(server, bad, from("203.0.113.10"))).status).toBe(429);
    // A stranger is not locked out by someone else's failures, and the live code still works.
    expect((await postPair(server, { code, device }, from("203.0.113.11"))).status).toBe(200);

    now += 60_000 + 1;
    for (let i = 0; i < 4; i += 1) {
      expect((await postPair(server, bad, from("203.0.113.10"))).status).toBe(401);
    }
    expect((await postPair(server, bad, from("203.0.113.10"))).status).toBe(429);
    now += 60_000 + 1;
    expect((await postPair(server, bad, from("203.0.113.10"))).status).toBe(429);
    now += 60_000;
    expect((await postPair(server, bad, from("203.0.113.10"))).status).toBe(401);
  });

  it("locks everyone briefly when many addresses fail together", async () => {
    let now = Date.parse("2026-06-01T00:00:00.000Z");
    const { server } = await boot(
      () => now,
      (header) => header,
    );
    const client = await rpc(server);
    const created = await client.call("remote.pairingCode.create");
    if (!created.ok) throw new Error("code was not created");
    const code = (created.result as { code: string }).code;
    const bad = { code: "23456789", device };
    for (let i = 0; i < 50; i += 1) {
      const headers = { "x-wooky-remote-address": `198.51.100.${(i % 25) + 1}` };
      await postPair(server, bad, headers);
    }
    const fresh = { "x-wooky-remote-address": "192.0.2.77" };
    expect((await postPair(server, { code, device }, fresh)).status).toBe(429);
    now += 60_000 + 1;
    expect((await postPair(server, { code, device }, fresh)).status).toBe(200);
  });
});
