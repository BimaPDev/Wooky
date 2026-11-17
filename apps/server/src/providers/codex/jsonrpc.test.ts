import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  JsonRpcClient,
  type JsonRpcNotificationMessage,
  JsonRpcRemoteError,
  UnhandledServerRequestError,
} from "./jsonrpc.ts";
import { InitializeResponseSchema } from "./protocol.ts";

const fakeServerPath = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

describe("JsonRpcClient", () => {
  let workDir = "";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "age-codex-rpc-"));
  });

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("correlates request responses and surfaces remote JSON-RPC errors", async () => {
    const client = new JsonRpcClient({
      bin: process.execPath,
      args: [fakeServerPath],
      cwd: workDir,
      onNotification: () => {},
      onServerRequest: async (req) => {
        throw new UnhandledServerRequestError(`Unhandled: ${req.method}`);
      },
    });

    try {
      await expect(client.request("thread/start", {}, z.unknown())).rejects.toBeInstanceOf(
        JsonRpcRemoteError,
      );

      const init = await client.request(
        "initialize",
        { clientInfo: { name: "age", title: "AGE", version: "0.0.0" }, capabilities: null },
        InitializeResponseSchema,
      );
      expect(init.userAgent).toContain("codex-fake");

      await expect(
        client.request(
          "initialize",
          { clientInfo: { name: "age", title: "AGE", version: "0.0.0" }, capabilities: null },
          InitializeResponseSchema,
        ),
      ).rejects.toThrow("Already initialized");
    } finally {
      await client.close();
    }
  });

  it("rejects all pending requests when the child process exits unexpectedly", async () => {
    const client = new JsonRpcClient({
      bin: process.execPath,
      args: ["-e", "process.stderr.write('boom on startup\\n'); process.exit(2);"],
      cwd: workDir,
      onNotification: () => {},
      onServerRequest: async () => ({}),
    });

    const p1 = client.request("initialize", {}, z.unknown());
    const p2 = client.request("thread/start", {}, z.unknown());

    await expect(p1).rejects.toThrow("boom on startup");
    await expect(p2).rejects.toThrow("boom on startup");
    await client.close();
  });

  it("drops an oversized stdout line, reports it, and keeps reading the next line", async () => {
    const notifications: JsonRpcNotificationMessage[] = [];
    const errors: Error[] = [];
    let resolvePing: (() => void) | undefined;
    const pinged = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });

    // 20 MiB with no newline exceeds the 16 MiB line cap, then a valid frame follows.
    const script = [
      'const big = "x".repeat(20 * 1024 * 1024);',
      'process.stdout.write(big + "\\n");',
      'process.stdout.write(JSON.stringify({ method: "ping", params: { ok: true } }) + "\\n");',
      "setInterval(() => {}, 1 << 30);",
    ].join("\n");

    const client = new JsonRpcClient({
      bin: process.execPath,
      args: ["-e", script],
      cwd: workDir,
      onNotification: (n) => {
        notifications.push(n);
        if (n.method === "ping") resolvePing?.();
      },
      onServerRequest: async () => ({}),
      onProtocolError: (err) => errors.push(err),
    });

    try {
      await pinged;
      expect(notifications.some((n) => n.method === "ping")).toBe(true);
      expect(errors.some((e) => /oversized/i.test(e.message))).toBe(true);
    } finally {
      await client.close();
    }
  });
});
