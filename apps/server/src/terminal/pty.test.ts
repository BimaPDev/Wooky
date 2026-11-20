import { afterEach, describe, expect, it } from "vitest";
import { AGENT_INTERNAL_ENV_KEYS } from "../providers/agent-env.ts";
import { terminalEnv } from "./pty.ts";

describe("terminalEnv", () => {
  it("keeps WOOKY_HOME and drops every other WOOKY_* key plus agent-env internals", () => {
    const env = terminalEnv({
      PATH: "/usr/bin",
      HOME: "/users/a",
      WOOKY_HOME: "/tmp/wooky",
      WOOKY_AGENT_TOKEN: "secret-token",
      WOOKY_THREAD_ID: "thread-1",
      WOOKY_SERVER_URL: "http://127.0.0.1:9",
      WOOKY_DEBUG: "1",
    });
    expect(env.WOOKY_HOME).toBe("/tmp/wooky");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/users/a");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.WOOKY_AGENT_TOKEN).toBeUndefined();
    expect(env.WOOKY_THREAD_ID).toBeUndefined();
    expect(env.WOOKY_SERVER_URL).toBeUndefined();
    expect(env.WOOKY_DEBUG).toBeUndefined();
    for (const key of AGENT_INTERNAL_ENV_KEYS) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe("spawned shell env", () => {
  const keys = ["WOOKY_AGENT_TOKEN", "WOOKY_THREAD_ID", "WOOKY_SERVER_URL", "WOOKY_DEBUG"] as const;
  const previous: Partial<Record<(typeof keys)[number], string | undefined>> = {};

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not pass fleet tokens through printenv",
    async () => {
      const { spawn } = await import("node:child_process");
      for (const key of keys) previous[key] = process.env[key];
      process.env.WOOKY_AGENT_TOKEN = "secret-token-xyz";
      process.env.WOOKY_THREAD_ID = "thread-secret";
      process.env.WOOKY_SERVER_URL = "http://secret.example";
      process.env.WOOKY_DEBUG = "1";
      process.env.WOOKY_HOME ??= "/tmp/wooky-home";

      const env = terminalEnv();
      const child = spawn("printenv", [], { env, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode) => resolve(exitCode));
      });
      expect(code).toBe(0);
      const output = Buffer.concat(chunks).toString("utf8");
      expect(output).not.toContain("secret-token-xyz");
      expect(output).not.toMatch(/^WOOKY_AGENT_TOKEN=/m);
      expect(output).not.toMatch(/^WOOKY_THREAD_ID=/m);
      expect(output).not.toMatch(/^WOOKY_SERVER_URL=/m);
      expect(output).not.toMatch(/^WOOKY_DEBUG=/m);
      expect(output).toMatch(/^WOOKY_HOME=/m);
      expect(output).toMatch(/^TERM=xterm-256color$/m);
      expect(output).toMatch(/^COLORTERM=truecolor$/m);
    },
  );
});
