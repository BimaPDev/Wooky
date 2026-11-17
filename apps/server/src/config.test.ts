import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGE_DEFAULT_PORT } from "@age/contracts";
import { resolveConfig } from "./config.ts";

describe("resolveConfig", () => {
  it("uses defaults", () => {
    expect(resolveConfig([], {})).toEqual({
      home: join(homedir(), ".age"),
      port: AGE_DEFAULT_PORT,
      host: "127.0.0.1",
      webDist: null,
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
    ).toEqual({ home: resolve("rel"), port: 0, host: "::1", webDist: "/w" });
  });

  it("rejects bad input and recognises --help", () => {
    expect(() => resolveConfig(["--port", "70000"], {})).toThrow(/Invalid port/);
    expect(() => resolveConfig(["--nope"], {})).toThrow(/Unknown option/);
    expect(resolveConfig(["--help"], {})).toBe("help");
  });
});
