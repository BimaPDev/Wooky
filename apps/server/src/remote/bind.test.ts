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

describe("hosting bind", () => {
  it("adds and removes the wildcard listeners when hosting is toggled", async () => {
    const home = await tempDir("bind");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      portExplicit: true,
      adapters: [createDemoAdapter({ stepMs: 0 })],
    });
    servers.push(server);
    expect(server.addresses()).toEqual(["127.0.0.1"]);
    const port = server.port;

    const socket = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
    sockets.push(socket);
    const pending = new Map<number, (response: RpcResponse) => void>();
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: unknown };
      if (typeof message.id !== "number") return;
      const response = RpcResponse.parse(message);
      pending.get(response.id)?.(response);
    });
    await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
    const call = (method: string, params: unknown) =>
      new Promise<RpcResponse>((resolve) => {
        pending.set(1, resolve);
        socket.send(JSON.stringify({ id: 1, method, params }));
      });

    const enabled = await call("settings.put", {
      settings: { hosting: { enabled: true, bind: "all" } },
    });
    expect(enabled.ok).toBe(true);
    expect(server.port).toBe(port);
    expect(server.addresses()).toEqual(expect.arrayContaining(["127.0.0.1", "0.0.0.0"]));
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

    const disabled = await call("settings.put", {
      settings: { hosting: { enabled: false } },
    });
    expect(disabled.ok).toBe(true);
    expect(server.addresses()).toEqual(["127.0.0.1"]);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
});
