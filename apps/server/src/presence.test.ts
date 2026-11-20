import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentAgentRuntime, setAgentRuntime } from "./providers/agent-env.ts";
import { discoverServerUrl, pidAlive, publishServerPresence, SERVER_DOWN } from "./presence.ts";
import { startServer } from "./server.ts";
import { tempDir } from "./testing.ts";

const wookyShimPath = (home: string) =>
  join(home, "bin", process.platform === "win32" ? "wooky.cmd" : "wooky");

describe("server presence", () => {
  let release: (() => void) | undefined;
  let home = "";

  afterEach(async () => {
    release?.();
    release = undefined;
    setAgentRuntime(null);
    if (home) await rm(home, { recursive: true, force: true });
    home = "";
  });

  it("writes server.json and an executable shim, then removes both", async () => {
    home = await tempDir("wooky-home");
    release = publishServerPresence(
      home,
      "http://127.0.0.1:4317",
      () => "2026-01-01T00:00:00.000Z",
    );

    const record = JSON.parse(await readFile(join(home, "server.json"), "utf8")) as {
      url: string;
      pid: number;
      startedAt: string;
    };
    expect(record).toEqual({
      url: "http://127.0.0.1:4317",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const shimPath = wookyShimPath(home);
    const shim = await readFile(shimPath, "utf8");
    expect(shim).toContain(`wooky-shim pid=${process.pid}`);
    expect(shim).toContain(process.execPath);
    expect(shim).toMatch(/^(#!\/bin\/sh|@echo off)/);
    expect(currentAgentRuntime()).toEqual({
      serverUrl: "http://127.0.0.1:4317",
      wookyBin: shimPath,
    });

    release();
    release = undefined;
    await expect(readFile(join(home, "server.json"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(shimPath, "utf8")).rejects.toThrow(/ENOENT/);
    expect(currentAgentRuntime()).toBeNull();
  });

  it.runIf(process.platform !== "win32")("sets the execute bit on the POSIX shim", async () => {
    home = await tempDir("wooky-home");
    release = publishServerPresence(home, "http://127.0.0.1:4317", () => "t");
    const mode = await stat(wookyShimPath(home));
    expect(mode.mode & 0o111).not.toBe(0);
    release();
    release = undefined;
  });

  it("replaces a dead age shim and leaves a live one's alone", async () => {
    home = await tempDir("wooky-home");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin", "age"), "#!/bin/sh\n# age-shim pid=2147483646\nexec true\n");
    await writeFile(join(home, "bin", "age.cmd"), "@echo off\r\nrem age-shim pid=2147483646\r\n");
    release = publishServerPresence(home, "http://127.0.0.1:4317", () => "t");
    await expect(readFile(join(home, "bin", "age"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(home, "bin", "age.cmd"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await readFile(wookyShimPath(home), "utf8")).toContain("wooky-shim");

    await writeFile(
      join(home, "bin", "age"),
      `#!/bin/sh\n# age-shim pid=${process.pid}\nexec true\n`,
    );
    release();
    release = undefined;
    await expect(readFile(join(home, "bin", "age"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("leaves a newer server's files in place", async () => {
    home = await tempDir("wooky-home");
    release = publishServerPresence(home, "http://127.0.0.1:1", () => "t");
    await writeFile(
      join(home, "server.json"),
      `${JSON.stringify({ url: "http://127.0.0.1:2", pid: process.pid + 1, startedAt: "later" })}\n`,
    );
    await writeFile(
      wookyShimPath(home),
      process.platform === "win32"
        ? "@echo off\r\nrem wooky-shim pid=0\r\n"
        : "#!/bin/sh\n# wooky-shim pid=0\nexec true\n",
    );
    release();
    release = undefined;
    const kept = JSON.parse(await readFile(join(home, "server.json"), "utf8")) as { url: string };
    expect(kept.url).toBe("http://127.0.0.1:2");
    expect(await readFile(wookyShimPath(home), "utf8")).toContain("pid=0");
  });

  it("discovers a live server.json and rejects a stale pid", async () => {
    home = await tempDir("wooky-home");
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2_147_483_646)).toBe(false);
    expect(() => discoverServerUrl({ WOOKY_HOME: home })).toThrow(SERVER_DOWN);

    await writeFile(
      join(home, "server.json"),
      JSON.stringify({ url: "http://127.0.0.1:9", pid: 2_147_483_646, startedAt: "t" }),
    );
    expect(() => discoverServerUrl({ WOOKY_HOME: home })).toThrow(SERVER_DOWN);

    await writeFile(
      join(home, "server.json"),
      JSON.stringify({ url: "http://127.0.0.1:4321", pid: process.pid, startedAt: "t" }),
    );
    expect(discoverServerUrl({ WOOKY_HOME: home })).toBe("http://127.0.0.1:4321");
    expect(discoverServerUrl({ WOOKY_HOME: home, WOOKY_SERVER_URL: "http://127.0.0.1:7" })).toBe(
      "http://127.0.0.1:7",
    );
  });
});

describe("startServer presence", () => {
  it("publishes server.json for the listening server and removes it on close", async () => {
    const home = await tempDir("wooky-home");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      adapters: [],
    });
    try {
      const record = JSON.parse(await readFile(join(home, "server.json"), "utf8")) as {
        url: string;
        pid: number;
      };
      expect(record.url).toBe(server.url);
      expect(record.pid).toBe(process.pid);
      expect(await readFile(wookyShimPath(home), "utf8")).toContain(process.execPath);
      expect(currentAgentRuntime()?.serverUrl).toBe(server.url);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
    await expect(readFile(join(home, "server.json"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(currentAgentRuntime()).toBeNull();
  });
});
