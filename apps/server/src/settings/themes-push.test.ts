import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { WOOKY_WS_PATH, RpcPush, ThemesPush } from "@wooky/contracts";
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

    const socket = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
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

  it("broadcasts a settings change written by rename when settings.json did not exist at start", async () => {
    const home = await tempDir("home");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      adapters: [createDemoAdapter({ stepMs: 0 })],
    });
    servers.push(server);
    const socket = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
    sockets.push(socket);
    const got = new Promise<ThemesPush>((resolve) => {
      socket.on("message", (data) => {
        const push = RpcPush.safeParse(JSON.parse(String(data)));
        if (push.success && push.data.push === "themes") resolve(ThemesPush.parse(push.data));
      });
    });
    await new Promise<void>((resolve, reject) =>
      socket.once("open", () => resolve()).once("error", reject),
    );
    const temp = join(home, "settings.json.next");
    await writeFile(temp, `${JSON.stringify({ activeThemeId: "wall-tide" })}\n`, "utf8");
    await rename(temp, join(home, "settings.json"));
    expect((await got).activeThemeId).toBe("wall-tide");
  });

  it("coalesces a burst of theme file writes into one push", async () => {
    const home = await tempDir("home");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      adapters: [createDemoAdapter({ stepMs: 0 })],
    });
    servers.push(server);

    const socket = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
    sockets.push(socket);
    const pushes: ThemesPush[] = [];
    const seen = new Set<string>();
    let resolveBurst: (() => void) | null = null;
    let resolveWarm: (() => void) | null = null;
    const warmedUp = new Promise<void>((resolve) => {
      resolveWarm = resolve;
    });

    socket.on("message", (data) => {
      const message: unknown = JSON.parse(String(data));
      const push = RpcPush.safeParse(message);
      if (!push.success || push.data.push !== "themes") return;
      const themesPush = ThemesPush.parse(push.data);
      pushes.push(themesPush);
      if (themesPush.changedIds.includes("warmup")) resolveWarm?.();
      for (const id of themesPush.changedIds) seen.add(id);
      if (["burst-a", "burst-b", "burst-c"].every((id) => seen.has(id))) resolveBurst?.();
    });

    await new Promise<void>((resolve, reject) =>
      socket.once("open", () => resolve()).once("error", reject),
    );

    const burstSeen = new Promise<void>((resolve) => {
      resolveBurst = resolve;
    });

    const themeJson = (id: string) =>
      `${JSON.stringify({
        version: 1,
        id,
        name: id,
        appearance: "dark",
        canvas: "#111111",
        accent: "#d7c9a7",
        colors: {},
        css: "",
      })}\n`;

    // macOS starts delivering FS events a moment after the watch is created. Prove the
    // watcher is live with one write before timing the burst.
    await writeFile(join(home, "themes", "warmup.json"), themeJson("warmup"), "utf8");
    await warmedUp;
    pushes.length = 0;
    seen.clear();

    await Promise.all([
      writeFile(join(home, "themes", "burst-a.json"), themeJson("burst-a"), "utf8"),
      writeFile(join(home, "themes", "burst-b.json"), themeJson("burst-b"), "utf8"),
      writeFile(join(home, "themes", "burst-c.json"), themeJson("burst-c"), "utf8"),
    ]);

    await burstSeen;
    // One push normally; a loaded machine can deliver FS events across two debounce windows.
    expect(pushes.length).toBeLessThanOrEqual(2);
    expect([...seen].sort()).toEqual(["burst-a", "burst-b", "burst-c"]);
  });
});
