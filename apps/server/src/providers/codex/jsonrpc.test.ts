import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const jsonRpcModulePath = fileURLToPath(new URL("./jsonrpc.ts", import.meta.url));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls the event loop (no sleep) until the pid is gone or the deadline passes. */
async function waitForPidToExit(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

function readLoggedFrames(logPath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

// A grandchild that ignores SIGTERM, standing in for a tool the app-server started.
// It announces its pid once the handler is installed so a test never races startup.
const STUBBORN_GRANDCHILD = [
  'process.on("SIGTERM", () => {});',
  'process.stdout.write(JSON.stringify({ method: "grandchild", params: { pid: process.pid } }) + "\\n");',
  "setInterval(() => {}, 1 << 30);",
].join("\n");

/**
 * Stand-in app-server that starts a SIGTERM-ignoring grandchild.
 * - "quiet": the grandchild's stdio is not shared with us; we idle until signalled.
 * - "shared-stdio": the grandchild inherits our stdout/stderr and so holds them open.
 * - "exit-early": like quiet, but we exit by ourselves once the grandchild is up.
 */
function appServerWithGrandchild(mode: "quiet" | "shared-stdio" | "exit-early"): string[] {
  const script = [
    'const { spawn } = require("node:child_process");',
    `const gcSource = ${JSON.stringify(STUBBORN_GRANDCHILD)};`,
    `const mode = ${JSON.stringify(mode)};`,
    'if (mode === "shared-stdio") {',
    '  spawn(process.execPath, ["-e", gcSource], { stdio: "inherit" });',
    "} else {",
    '  const gc = spawn(process.execPath, ["-e", gcSource], { stdio: ["ignore", "pipe", "ignore"] });',
    '  gc.stdout.on("data", (chunk) => {',
    "    process.stdout.write(chunk, () => {",
    '      if (mode === "exit-early") process.exit(0);',
    "    });",
    "  });",
    "}",
    "setInterval(() => {}, 1 << 30);",
  ].join("\n");
  return ["-e", script];
}

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

  it("rejects a line that crosses the cap in the same chunk as its newline", async () => {
    const errors: Error[] = [];
    let resolvePing: (() => void) | undefined;
    const pinged = new Promise<void>((resolve) => {
      resolvePing = resolve;
    });

    // The first write stops 10 bytes short of the 16 MiB cap, so nothing is dropped
    // yet. The second write crosses the cap and carries the newline in one chunk.
    const script = [
      "const cap = 16 * 1024 * 1024;",
      'process.stdout.write("x".repeat(cap - 10), () => {',
      '  process.stdout.write("x".repeat(110) + "\\n");',
      '  process.stdout.write(JSON.stringify({ method: "ping", params: {} }) + "\\n");',
      "});",
      "setInterval(() => {}, 1 << 30);",
    ].join("\n");

    const client = new JsonRpcClient({
      bin: process.execPath,
      args: ["-e", script],
      cwd: workDir,
      onNotification: (n) => {
        if (n.method === "ping") resolvePing?.();
      },
      onServerRequest: async () => ({}),
      onProtocolError: (err) => errors.push(err),
    });

    try {
      await pinged;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toMatch(/oversized/i);
    } finally {
      await client.close();
    }
  }, 30_000);

  describe("process-group teardown", () => {
    function startStubbornClient(mode: "quiet" | "shared-stdio" | "exit-early") {
      let resolvePid: ((pid: number) => void) | undefined;
      const grandchildPid = new Promise<number>((resolve) => {
        resolvePid = resolve;
      });
      const client = new JsonRpcClient({
        bin: process.execPath,
        args: appServerWithGrandchild(mode),
        cwd: workDir,
        killGraceMs: 100,
        stdioGraceMs: 50,
        onNotification: (n) => {
          if (n.method === "grandchild") {
            resolvePid?.((n.params as { pid: number }).pid);
          }
        },
        onServerRequest: async () => ({}),
      });
      return { client, grandchildPid };
    }

    it("escalates to SIGKILL for a grandchild that ignores SIGTERM after the app-server exits", async () => {
      const { client, grandchildPid } = startStubbornClient("quiet");
      const gcPid = await grandchildPid;
      try {
        await client.close();
        expect(await waitForPidToExit(gcPid)).toBe(true);
      } finally {
        if (isPidAlive(gcPid)) process.kill(gcPid, "SIGKILL");
      }
    }, 20_000);

    it("does not hang close() when a grandchild keeps the inherited stdout open", async () => {
      const { client, grandchildPid } = startStubbornClient("shared-stdio");
      const gcPid = await grandchildPid;
      try {
        await client.close();
        expect(await waitForPidToExit(gcPid)).toBe(true);
      } finally {
        if (isPidAlive(gcPid)) process.kill(gcPid, "SIGKILL");
      }
    }, 20_000);

    it("still signals the group when the app-server already exited on its own", async () => {
      const { client, grandchildPid } = startStubbornClient("exit-early");
      const gcPid = await grandchildPid;
      try {
        await client.closed;
        expect(isPidAlive(gcPid)).toBe(true);
        await client.close();
        expect(await waitForPidToExit(gcPid)).toBe(true);
      } finally {
        if (isPidAlive(gcPid)) process.kill(gcPid, "SIGKILL");
      }
    }, 20_000);
  });

  describe("exit guard", () => {
    it("removes its process exit listener once the group is gone", async () => {
      const before = process.listenerCount("exit");
      const client = new JsonRpcClient({
        bin: process.execPath,
        args: [fakeServerPath],
        cwd: workDir,
        onNotification: () => {},
        onServerRequest: async () => ({}),
      });
      expect(process.listenerCount("exit")).toBe(before + 1);
      await client.close();
      expect(process.listenerCount("exit")).toBe(before);
    });

    it("kills the app-server's group when the Wooky process exits without closing the client", async () => {
      const script = [
        `import { JsonRpcClient } from ${JSON.stringify(jsonRpcModulePath)};`,
        "const client = new JsonRpcClient({",
        "  bin: process.execPath,",
        '  args: ["-e", "setInterval(() => {}, 1 << 30);"],',
        "  cwd: process.cwd(),",
        "  onNotification: () => {},",
        "  onServerRequest: async () => ({}),",
        "});",
        "process.stdout.write(String(client.pid), () => process.exit(0));",
      ].join("\n");

      const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: workDir,
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      host.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      await new Promise<void>((resolve) => host.on("close", () => resolve()));

      const appServerPid = Number(output.trim());
      expect(Number.isInteger(appServerPid)).toBe(true);
      try {
        expect(await waitForPidToExit(appServerPid)).toBe(true);
      } finally {
        if (isPidAlive(appServerPid)) process.kill(appServerPid, "SIGKILL");
      }
    }, 20_000);
  });

  // Must match PENDING_APPROVALS in the fake app-server.
  const PENDING_APPROVALS = 8;

  describe("teardown", () => {
    async function tearDownWithPendingRequests(logFile: string) {
      const received: string[] = [];
      let resolveAll: (() => void) | undefined;
      const allReceived = new Promise<void>((resolve) => {
        resolveAll = resolve;
      });
      const client = new JsonRpcClient({
        bin: process.execPath,
        args: [fakeServerPath, "--scenario", "pending-requests", "--log-file", logFile],
        cwd: workDir,
        onNotification: () => {},
        // Never answer: the requests stay pending until teardown cancels them.
        onServerRequest: (req) => {
          received.push(req.method);
          if (received.length === PENDING_APPROVALS + 1) resolveAll?.();
          return new Promise<unknown>(() => {});
        },
        cancelServerRequest: (req) =>
          req.method === "item/commandExecution/requestApproval" ||
          req.method === "item/fileChange/requestApproval"
            ? { decision: "decline" }
            : undefined,
      });

      const params = {
        clientInfo: { name: "age", title: "AGE", version: "0.0.0" },
        capabilities: null,
      };
      await client.request("initialize", params, InitializeResponseSchema);
      client.notify("initialized");
      await client.request("thread/start", {}, z.unknown());
      await client.request("turn/start", {}, z.unknown());
      await allReceived;

      const settled = await Promise.all([
        client.abort({ threadId: "thr_started_1", turnId: "turn_fake_1" }),
        client.close(),
        client.abort({ threadId: "thr_started_1", turnId: "turn_fake_1" }),
      ]);
      expect(settled[0]).toBe(settled[1]);
      return readLoggedFrames(logFile);
    }

    it("answers each pending approval with exactly one decline when abort and close race", async () => {
      const frames = await tearDownWithPendingRequests(join(workDir, "race.jsonl"));
      const replies = frames.filter((f) => !("method" in f) && typeof f.id === "number");
      const declines = replies.filter(
        (f) => JSON.stringify(f.result) === JSON.stringify({ decision: "decline" }),
      );
      expect(declines.map((f) => f.id)).toEqual(
        Array.from({ length: PENDING_APPROVALS }, (_, i) => 500 + i),
      );

      // Strict order, each step once: interrupt, then the declines.
      const interrupts = frames.filter((f) => f.method === "turn/interrupt");
      expect(interrupts).toHaveLength(1);
      expect(frames.indexOf(interrupts[0] as Record<string, unknown>)).toBeLessThan(
        frames.indexOf(declines[0] as Record<string, unknown>),
      );
    });

    it("answers a pending request that has no cancel reply with a JSON-RPC error", async () => {
      const frames = await tearDownWithPendingRequests(join(workDir, "error-reply.jsonl"));
      const reply = frames.find((f) => f.id === 500 + PENDING_APPROVALS && !("method" in f));
      expect(reply).toBeDefined();
      expect(reply).not.toHaveProperty("result");
      expect(reply?.error).toMatchObject({ code: -32603 });
    });
  });
});
