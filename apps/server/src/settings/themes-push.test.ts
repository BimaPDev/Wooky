import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AGE_WS_PATH, RpcPush, ThemesPush } from "@age/contracts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { tempDir } from "../testing.ts";

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
});

describe("themes push", () => {
  it("broadcasts when a theme file is written from outside RPC", async () => {
    const home = await tempDir("home");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      adapters: [createDemoAdapter({ stepMs: 0 })],
    });
    servers.push(server);

    const socket = new WebSocket(`${server.url.replace("http", "ws")}${AGE_WS_PATH}`);
    sockets.push(socket);
    const pushes: ThemesPush[] = [];
    const waiters: ((push: ThemesPush) => void)[] = [];

    socket.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      const push = RpcPush.safeParse(message);
      if (!push.success || push.data.push !== "themes") return;
      const themesPush = ThemesPush.parse(push.data);
      pushes.push(themesPush);
      for (const resolve of waiters.splice(0)) resolve(themesPush);
    });

    await new Promise<void>((resolve, reject) =>
      socket.once("open", () => resolve()).once("error", reject),
    );

    const nextPush = (): Promise<ThemesPush> => {
      const latest = pushes.at(-1);
      if (latest) return Promise.resolve(latest);
      return new Promise((resolve) => waiters.push(resolve));
    };

    await writeFile(
      join(home, "themes", "cli-paper.json"),
      `${JSON.stringify({
        version: 1,
        id: "cli-paper",
        name: "CLI Paper",
        appearance: "dark",
        canvas: "#111111",
        accent: "#d7c9a7",
        colors: {},
        css: "",
      })}\n`,
      "utf8",
    );

    const push = await nextPush();
    expect(push.changedIds).toContain("cli-paper");
    expect(push.activeThemeId).toBe("default");
  });
});
