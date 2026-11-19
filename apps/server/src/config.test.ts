import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGE_DEFAULT_PORT } from "@wooky/contracts";
import { resolveConfig } from "./config.ts";

describe("resolveConfig", () => {
  it("uses defaults", () => {
    expect(resolveConfig([], {})).toEqual({
      home: join(homedir(), ".age"),
      port: AGE_DEFAULT_PORT,
      host: "127.0.0.1",
      webDist: null,
      allowedHosts: [],
      allowRemotePicker: false,
    });
  });

  it("prefers flags over environment variables", () => {
    const env = { AGE_HOME: "/env/home", AGE_PORT: "5000", AGE_WEB_DIST: "/env/web" };
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
      allowRemotePicker: false,
    });
  });

  it("collects allowed hosts from flags and the environment", () => {
    const config = resolveConfig(["--allow-host", "Box.LAN", "--allow-host", "mac.tailnet"], {
      AGE_ALLOWED_HOSTS: " studio.local, ,",
    });
    expect(config).toMatchObject({ allowedHosts: ["box.lan", "mac.tailnet", "studio.local"] });
  });

  it("keeps the remote folder chooser off unless the operator opts in", () => {
    expect(resolveConfig([], {})).toMatchObject({ allowRemotePicker: false });
    expect(resolveConfig([], { AGE_ALLOW_REMOTE_PICKER: "1" })).toMatchObject({
      allowRemotePicker: true,
    });
    expect(resolveConfig(["--allow-remote-picker"], {})).toMatchObject({
      allowRemotePicker: true,
    });
  });

  it("rejects bad input and recognises --help", () => {
    expect(() => resolveConfig(["--port", "70000"], {})).toThrow(/Invalid port/);
    expect(() => resolveConfig(["--nope"], {})).toThrow(/Unknown option/);
    expect(resolveConfig(["--help"], {})).toBe("help");
  });
});
