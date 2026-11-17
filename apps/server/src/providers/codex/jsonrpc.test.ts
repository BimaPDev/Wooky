import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonRpcClient, JsonRpcRemoteError, UnhandledServerRequestError } from "./jsonrpc.ts";
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
});
