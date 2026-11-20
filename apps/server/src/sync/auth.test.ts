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

const PEER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

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

async function pairDevice(
  server: RunningServer,
  client: Awaited<ReturnType<typeof rpc>>,
  deviceId: string,
): Promise<string> {
  const created = await client.call("remote.pairingCode.create");
  if (!created.ok) throw new Error("no pairing code");
  const { code } = created.result as { code: string };
  const response = await fetch(`${server.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      device: { deviceId, name: deviceId, platform: "other", version: "0.0.0" },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe("/sync/* against the real device auth", () => {
  it("needs a live device token, serves only listed peers, and drops a revoked device", async () => {
    const home = await tempDir("sync-auth");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
    });
    servers.push(server);
    const client = await rpc(server);
    const put = await client.call("settings.put", {
      settings: { sync: { enabled: true, peers: [PEER] } },
    });
    expect(put.ok).toBe(true);
    const peerToken = await pairDevice(server, client, PEER);
    const strangerToken = await pairDevice(server, client, STRANGER);
    const get = (path: string, token?: string) =>
      fetch(`${server.url}${path}`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });

    // Loopback is not a device: the peer routes still want a token.
    expect((await get("/sync/tips")).status).toBe(401);
    expect((await get("/sync/bundle?project=x")).status).toBe(401);
    expect((await get("/sync/tips", "not-a-token")).status).toBe(401);
    expect((await get("/sync/tips", "")).status).toBe(401);
    expect((await get("/sync/tips", strangerToken)).status).toBe(403);
    expect((await get("/sync/tips", peerToken)).status).toBe(200);
    expect((await get("/sync/bundle", peerToken)).status).toBe(400);
    expect((await get("/sync/bundle?project=missing", peerToken)).status).toBe(404);

    const revoked = await client.call("remote.devices.revoke", { deviceId: PEER });
    expect(revoked.ok).toBe(true);
    expect((await get("/sync/tips", peerToken)).status).toBe(401);
    expect((await get("/sync/bundle?project=missing", peerToken)).status).toBe(401);
  });
});
