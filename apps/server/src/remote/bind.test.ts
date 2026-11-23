import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RpcResponse, WOOKY_WS_PATH, type HostingSettings } from "@wooky/contracts";
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
    expect(server.addresses()).toContain("0.0.0.0");
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

    const disabled = await call("settings.put", {
      settings: { hosting: { enabled: false } },
    });
    expect(disabled.ok).toBe(true);
    expect(server.addresses()).toEqual(["127.0.0.1"]);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
});

describe("bind manager rollback", () => {
  it("keeps serving loopback when the wildcard bind fails", async () => {
    const { createBindManager } = await import("./bind.ts");
    const { Server } = await import("node:net");
    const hosting = { enabled: false, bind: "loopback", port: 0 } as HostingSettings;
    const manager = createBindManager({
      host: "127.0.0.1",
      port: 0,
      hostExplicit: false,
      portExplicit: false,
      getHosting: () => hosting,
      tailnetIps: async () => [],
    });
    manager.setHandler((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const { port } = await manager.apply();
    try {
      // Every wildcard bind fails, as if another process held 0.0.0.0:port.
      const realListen = Server.prototype.listen;
      const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
        this: InstanceType<typeof Server>,
        ...args: unknown[]
      ) {
        const wildcard = args.some(
          (arg) => arg === "0.0.0.0" || (arg as { host?: string })?.host === "::",
        );
        if (!wildcard)
          return (realListen as (...a: unknown[]) => unknown).apply(this, args) as never;
        process.nextTick(() =>
          this.emit("error", Object.assign(new Error("address in use"), { code: "EADDRINUSE" })),
        );
        return this;
      } as never);
      Object.assign(hosting, { enabled: true, bind: "all", port });
      await expect(manager.apply()).rejects.toThrow(/address in use/);
      spy.mockRestore();
      expect(manager.addresses()).toEqual(["127.0.0.1"]);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      await manager.closeServers();
    }
  });
});
