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

// A grandchild that shuts down about 30 ms after SIGTERM, like a tool finishing its cleanup.
const GRACEFUL_GRANDCHILD = [
  'process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 30); });',
  'process.stdout.write(JSON.stringify({ method: "grandchild", params: { pid: process.pid } }) + "\\n");',
  "setInterval(() => {}, 1 << 30);",
].join("\n");

/**
 * Stand-in app-server that starts a grandchild (SIGTERM-ignoring unless noted).
 * - "quiet": the grandchild's stdio is not shared with us; we idle until signalled.
 * - "shared-stdio": the grandchild inherits our stdout/stderr and so holds them open.
 * - "exit-early": like quiet, but we exit by ourselves once the grandchild is up.
 * - "graceful": like quiet, but the grandchild exits ~30 ms after SIGTERM.
 */
function appServerWithGrandchild(
  mode: "quiet" | "shared-stdio" | "exit-early" | "graceful",
): string[] {
  const script = [
    'const { spawn } = require("node:child_process");',
    `const gcSource = ${JSON.stringify(mode === "graceful" ? GRACEFUL_GRANDCHILD : STUBBORN_GRANDCHILD)};`,
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
    workDir = mkdtempSync(join(tmpdir(), "wooky-codex-rpc-"));
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
        { clientInfo: { name: "wooky", title: "Wooky", version: "0.0.0" }, capabilities: null },
        InitializeResponseSchema,
      );
      expect(init.userAgent).toContain("codex-fake");

      await expect(
        client.request(
          "initialize",
          { clientInfo: { name: "wooky", title: "Wooky", version: "0.0.0" }, capabilities: null },
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

  describe.skipIf(process.platform === "win32")("process-group teardown", () => {
    function startStubbornClient(
      mode: "quiet" | "shared-stdio" | "exit-early" | "graceful",
      grace: "short" | "default" = "short",
    ) {
      let resolvePid: ((pid: number) => void) | undefined;
      const grandchildPid = new Promise<number>((resolve) => {
        resolvePid = resolve;
      });
      const client = new JsonRpcClient({
        bin: process.execPath,
        args: appServerWithGrandchild(mode),
        cwd: workDir,
        // "default" leaves killGraceMs unset so the client's own 3 s default applies.
        ...(grace === "short" ? { killGraceMs: 100 } : {}),
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
        // close() resolves only once the whole group is gone.
        expect(isPidAlive(gcPid)).toBe(false);
      } finally {
        if (isPidAlive(gcPid)) process.kill(gcPid, "SIGKILL");
      }
    }, 20_000);

    it("does not hang close() when a grandchild keeps the inherited stdout open", async () => {
      const { client, grandchildPid } = startStubbornClient("shared-stdio");
      const gcPid = await grandchildPid;
      try {
        await client.close();
        // close() resolves only once the whole group is gone.
        expect(isPidAlive(gcPid)).toBe(false);
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
        // close() resolves only once the whole group is gone.
        expect(isPidAlive(gcPid)).toBe(false);
      } finally {
        if (isPidAlive(gcPid)) process.kill(gcPid, "SIGKILL");
      }
    }, 20_000);

    it("resolves close() promptly when the group dies just after the app-server, at the default grace", async () => {
      const { client, grandchildPid } = startStubbornClient("graceful", "default");
      const gcPid = await grandchildPid;
      try {
        const startedAt = performance.now();
        await client.close();
        const elapsedMs = performance.now() - startedAt;
        expect(isPidAlive(gcPid)).toBe(false);
        // The default grace is 3 s; a group that exits by itself must not wait it out.
        expect(elapsedMs).toBeLessThan(1_000);
      } finally {
        if (isPidAlive(gcPid)) process.kill(gcPid, "SIGKILL");
      }
    }, 20_000);

    it("lets a process whose only live work is close() finish with exit code 0", async () => {
      const script = [
        `import { JsonRpcClient } from ${JSON.stringify(jsonRpcModulePath)};`,
        "let announced;",
        "const up = new Promise((resolve) => { announced = resolve; });",
        "const client = new JsonRpcClient({",
        "  bin: process.execPath,",
        `  args: ${JSON.stringify(appServerWithGrandchild("quiet"))},`,
        "  cwd: process.cwd(),",
        "  killGraceMs: 200,",
        "  onNotification: (n) => { if (n.method === 'grandchild') announced(); },",
        "  onServerRequest: async () => ({}),",
        "});",
        "await up;",
        "await client.close();",
        'process.stdout.write("closed");',
      ].join("\n");

      const host = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: workDir,
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      host.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve) => host.on("close", resolve));
      // Without ref'd teardown timers node exits 13 (unsettled top-level await).
      expect(code).toBe(0);
      expect(output).toBe("closed");
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

    it("shares one exit listener across many live clients and removes it when they close", async () => {
      const before = process.listenerCount("exit");
      const clients = Array.from(
        { length: 12 },
        () =>
          new JsonRpcClient({
            bin: process.execPath,
            args: [fakeServerPath],
            cwd: workDir,
            onNotification: () => {},
            onServerRequest: async () => ({}),
          }),
      );
      expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
      await Promise.all(clients.map((client) => client.close()));
      expect(process.listenerCount("exit")).toBe(before);
    });

    it.skipIf(process.platform === "win32")(
      "kills the app-server's group when the Wooky process exits without closing the client",
      async () => {
        // The host's exit listener is registered after the client's guard, so it runs
        // once the guard has signalled the group. It then waits (Atomics.wait, bounded,
        // not a spin) for the group to disappear and reports what it saw before it dies.
        const script = [
          'import { spawnSync } from "node:child_process";',
          'import { writeSync } from "node:fs";',
          `import { JsonRpcClient } from ${JSON.stringify(jsonRpcModulePath)};`,
          "const client = new JsonRpcClient({",
          "  bin: process.execPath,",
          '  args: ["-e", "setInterval(() => {}, 1 << 30);"],',
          "  cwd: process.cwd(),",
          "  onNotification: () => {},",
          "  onServerRequest: async () => ({}),",
          "});",
          "const pid = client.pid;",
          "const groupAlive = () => {",
          "  try { process.kill(-pid, 0); } catch { return false; }",
          // A killed child stays a zombie until this host reaps it; count that as gone.
          '  const ps = spawnSync("ps", ["-o", "stat=", "-g", String(pid)], { encoding: "utf8" });',
          '  const states = ps.stdout.split("\\n").filter((line) => line.trim().length > 0);',
          '  return !states.every((state) => state.trim().startsWith("Z"));',
          "};",
          'process.on("exit", () => {',
          "  const deadline = Date.now() + 5000;",
          "  while (groupAlive() && Date.now() < deadline) {",
          // wooky-allow sleep: synchronous exit handler; no event exists for process-group exit
          "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
          "  }",
          "  writeSync(1, JSON.stringify({ pid, groupGone: !groupAlive() }));",
          "});",
          "process.exit(0);",
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

        const report = JSON.parse(output) as { pid: number; groupGone: boolean };
        try {
          expect(Number.isInteger(report.pid)).toBe(true);
          expect(report.groupGone).toBe(true);
        } finally {
          if (isPidAlive(report.pid)) process.kill(report.pid, "SIGKILL");
        }
      },
      20_000,
    ); // POSIX process groups and `ps -g`
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
        clientInfo: { name: "wooky", title: "Wooky", version: "0.0.0" },
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
