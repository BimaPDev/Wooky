import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WOOKY_DEFAULT_PORT } from "@wooky/contracts";
import { resolveConfig } from "./config.ts";

describe("resolveConfig", () => {
  it("uses defaults", () => {
    expect(resolveConfig([], {})).toEqual({
      home: join(homedir(), ".wooky"),
      port: WOOKY_DEFAULT_PORT,
      host: "127.0.0.1",
      webDist: null,
      allowedHosts: [],
      hostExplicit: false,
      portExplicit: false,
    });
  });

  it("prefers flags over environment variables", () => {
    const env = { WOOKY_HOME: "/env/home", WOOKY_PORT: "5000", WOOKY_WEB_DIST: "/env/web" };
    expect(resolveConfig([], env)).toMatchObject({
      home: "/env/home",
      port: 5000,
      webDist: "/env/web",
    });
    expect(
      resolveConfig(["--port", "0", "--home", "rel", "--host", "::1", "--web-dist", "/w"], env),
    ).toEqual({
      home: resolve("rel"),
      port: 0,
      host: "::1",
      webDist: "/w",
      allowedHosts: [],
      hostExplicit: true,
      portExplicit: true,
    });
  });

  it("collects allowed hosts from flags and the environment", () => {
    const config = resolveConfig(["--allow-host", "Box.LAN", "--allow-host", "mac.tailnet"], {
      WOOKY_ALLOWED_HOSTS: " studio.local, ,",
    });
    expect(config).toMatchObject({ allowedHosts: ["box.lan", "mac.tailnet", "studio.local"] });
  });

  it("rejects bad input and recognises --help", () => {
    expect(() => resolveConfig(["--port", "70000"], {})).toThrow(/Invalid port/);
    expect(() => resolveConfig(["--nope"], {})).toThrow(/Unknown option/);
    expect(resolveConfig(["--help"], {})).toBe("help");
  });

  it("uses hosting.port from settings.json when no port flag or env is set", () => {
    const home = mkdtempSync(join(tmpdir(), "wooky-cfg-"));
    try {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ hosting: { port: 5123 } }));
      expect(resolveConfig([], { WOOKY_HOME: home })).toMatchObject({ port: 5123 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
