import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import type { ProviderEvent, ProviderStatus, ReadModel } from "@wooky/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { startServer, type RunningServer } from "../server.ts";
import { tempDir } from "../testing.ts";
import {
  assertWaitingThread,
  formatToolResult,
  resolveDefaultTarget,
  rpcSessionLoad,
} from "./mcp-tools.ts";
import { runMcpCli, type McpIo } from "./mcp.ts";
import { rpcCall } from "./rpc-client.ts";

const DOWN = "Wooky is not running. Start it with `wooky` or open the app.";
const DEMO_ANSWER = "Done. I added a line to WOOKY_DEMO.md and ran echo ok.";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await cleanupTestRepos();
});

/** Write every line, close stdin, and return each response. Notifications produce no line. */
async function mcp(args: string[], env: NodeJS.ProcessEnv, lines: string[]) {
  const stdin = new PassThrough();
  let out = "";
  let err = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      out += String(chunk);
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      err += String(chunk);
      callback();
    },
  });
  const io: McpIo = { stdin, stdout, stderr };
  const done = runMcpCli(args, env, io);
  for (const line of lines) stdin.write(`${line.replace(/\n$/, "")}\n`);
  stdin.end();
  await done;
  const messages = out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  return { messages, stderr: err };
}

/** One long-lived stdio server. Each `send` is a request that expects one response. */
function openMcp(args: string[], env: NodeJS.ProcessEnv) {
  const queued: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  let carry = "";
  let err = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      carry += String(chunk);
      let nl = carry.indexOf("\n");
      while (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(line);
        } else queued.push(line);
        nl = carry.indexOf("\n");
      }
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      err += String(chunk);
      callback();
    },
  });
  const stdin = new PassThrough();
  const done = runMcpCli(args, env, { stdin, stdout, stderr });
  let ended = false;
  return {
    stderr: () => err,
    async send(line: string): Promise<unknown> {
      const next = new Promise<string>((resolve) => {
        const ready = queued.shift();
        if (ready !== undefined) resolve(ready);
        else waiter = resolve;
      });
      stdin.write(`${line.replace(/\n$/, "")}\n`);
      return JSON.parse(await next) as unknown;
    },
    end(): Promise<void> {
      if (!ended) {
        ended = true;
        stdin.end();
      }
      return done;
    },
  };
}

function request(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function tool(id: number, name: string, args: Record<string, unknown> = {}): string {
  return request(id, "tools/call", { name, arguments: args });
}

function toolsOf(
  message: unknown,
): { name: string; description: string; inputSchema: { type: string } }[] {
  if (!message || typeof message !== "object" || !("result" in message)) {
    throw new Error(`Expected a result, got ${JSON.stringify(message)}`);
  }
  const result = message.result as {
    tools?: { name: string; description: string; inputSchema: { type: string } }[];
  };
  if (!result.tools) throw new Error(`Expected tools, got ${JSON.stringify(message)}`);
  return result.tools;
}

function resultOf(message: unknown): { isError: boolean; text: string; json: unknown } {
  if (!message || typeof message !== "object" || !("result" in message)) {
    throw new Error(`Expected a result, got ${JSON.stringify(message)}`);
  }
  const result = message.result as { content?: { text?: string }[]; isError?: boolean };
  const text = result.content?.[0]?.text ?? "";
  const json =
    text.startsWith("{") || text.startsWith("[") ? (JSON.parse(text) as unknown) : undefined;
  return { isError: result.isError === true, text, json };
}

async function boot(
  projectCount = 1,
): Promise<{ env: NodeJS.ProcessEnv; projectIds: string[]; url: string }> {
  const home = await tempDir("mcp");
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    adapters: [createDemoAdapter({ stepMs: 0 })],
  });
  cleanups.push(async () => {
    await server.close();
    await rm(home, { recursive: true, force: true });
  });
  const projectIds: string[] = [];
  for (let index = 0; index < projectCount; index += 1) {
    const root = await makeRepo();
    await rpcCall(server.url, "dispatch", {
      commandId: randomUUID(),
      type: "project.add",
      root,
      name: `project-${index}`,
    });
    const snap = await rpcCall(server.url, "snapshot", {});
    const project = Object.values(snap.projects).find((candidate) => candidate.root === root);
    if (!project) throw new Error("Project was not created.");
    projectIds.push(project.id);
  }
  return { env: { WOOKY_HOME: home }, projectIds, url: server.url };
}

function agentStatus(kind: ProviderStatus["kind"], models: string[]): ProviderStatus {
  return {
    kind,
    label: kind,
    installed: true,
    authenticated: true,
    version: null,
    models: models.map((id) => ({ id, label: id })),
    problem: null,
  };
}

/** A demo turn that stays running until the server aborts it. */
function holdDemo(): ProviderAdapter {
  return {
    kind: "demo",
    async probe() {
      return {
        kind: "demo",
        label: "Demo",
        installed: true,
        authenticated: true,
        version: null,
        models: [{ id: "demo", label: "Demo" }],
        problem: null,
      };
    },
    runTurn(input) {
      return (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: "session", sessionId: `hold-${input.threadId}` };
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) {
            resolve();
            return;
          }
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "done",
          status: "interrupted",
          error: null,
          nativeRef: `hold-${input.turnId}`,
        };
      })();
    },
  };
}

describe("wooky mcp", () => {
  it("completes the initialize handshake and answers ping", async () => {
    const { messages, stderr } = await mcp([], {}, [
      request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      request(2, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "old", version: "0" },
      }),
      request(3, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mid", version: "0" },
      }),
      request(4, "ping"),
      request(5, "tools/nope"),
      request(6, "initialize", {
        protocolVersion: "1999-01-01",
        capabilities: {},
        clientInfo: { name: "future", version: "0" },
      }),
    ]);
    expect(stderr).toBe("");
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "wooky" } },
    });
    expect(messages[1]).toMatchObject({ id: 2, result: { protocolVersion: "2024-11-05" } });
    expect(messages[2]).toMatchObject({ id: 3, result: { protocolVersion: "2025-03-26" } });
    expect(messages[3]).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    expect(messages[4]).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32601, message: "Method not found" },
    });
    expect(messages[5]).toMatchObject({ id: 6, result: { protocolVersion: "2025-06-18" } });
  });

  it("lists tools and hides approve unless --allow-approvals is set", async () => {
    const hidden = await mcp([], {}, [request(1, "tools/list")]);
    const tools = toolsOf(hidden.messages[0]);
    expect(tools.map((entry) => entry.name)).toEqual([
      "wooky_overview",
      "wooky_list_threads",
      "wooky_create_task",
      "wooky_send",
      "wooky_wait",
      "wooky_read",
      "wooky_interrupt",
      "brain_ls",
      "brain_read",
      "brain_search",
      "brain_write",
      "brain_claim",
      "brain_release",
      "brain_handoff",
      "brain_finding",
    ]);
    for (const entry of tools) expect(entry.inputSchema.type).toBe("object");

    const denied = await mcp([], {}, [
      tool(1, "wooky_approve", { threadId: "t", approvalId: "a", decision: "approve" }),
    ]);
    expect(resultOf(denied.messages[0]).isError).toBe(true);
    expect(resultOf(denied.messages[0]).text).toContain("--allow-approvals");

    const shown = await mcp(["--allow-approvals"], {}, [request(1, "tools/list")]);
    const approve = toolsOf(shown.messages[0]).find((entry) => entry.name === "wooky_approve");
    expect(approve?.description).toContain("--allow-approvals");
  });

  it("creates a demo task, waits for it, and reads the answer", async () => {
    const { env, projectIds } = await boot();
    const session = openMcp(["--allow-full"], env);
    try {
      const created = resultOf(
        await session.send(
          tool(1, "wooky_create_task", {
            projectId: projectIds[0] ?? "",
            prompt: "Add a demo note",
            provider: "demo",
            model: "demo",
          }),
        ),
      );
      expect(created.isError).toBe(false);
      const threadId = (created.json as { threadId?: string }).threadId ?? "";
      expect(threadId.length).toBeGreaterThan(0);

      const waited = resultOf(
        await session.send(tool(2, "wooky_wait", { threadId, timeoutMs: 10_000 })),
      );
      expect(waited.isError).toBe(false);
      expect(waited.json).toMatchObject({ state: "finished", turnStatus: "completed", threadId });

      const read = resultOf(await session.send(tool(3, "wooky_read", { threadId })));
      expect(read.isError).toBe(false);
      const body = read.json as {
        turns: { text: string; status: string }[];
        diffStat: { files: number; additions: number } | null;
      };
      expect(body.turns.at(-1)).toMatchObject({ status: "completed", text: DEMO_ANSWER });
      expect(body.diffStat?.files).toBe(1);
      expect(session.stderr()).toBe("");
    } finally {
      await session.end();
    }
  }, 20_000);

  it("rejects project ids outside --projects", async () => {
    const { env, projectIds } = await boot(2);
    const [allowed, other] = projectIds;
    const session = openMcp(["--projects", allowed ?? ""], env);
    try {
      const overview = resultOf(await session.send(tool(1, "wooky_overview")));
      expect(overview.isError).toBe(false);
      expect(overview.json).toMatchObject({
        projects: [{ id: allowed }],
      });
      const rejected = resultOf(
        await session.send(
          tool(2, "wooky_create_task", { projectId: other ?? "", prompt: "do not start" }),
        ),
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain(other);
      expect(rejected.text).toContain("outside");
    } finally {
      await session.end();
    }
  }, 20_000);

  it("hides write tools in read-only mode", async () => {
    const { messages } = await mcp(["--read-only"], {}, [
      request(1, "tools/list"),
      tool(2, "wooky_create_task", { projectId: "p", prompt: "no" }),
      tool(3, "wooky_send", { threadId: "t", prompt: "no" }),
      tool(4, "wooky_interrupt", { threadId: "t" }),
    ]);
    expect(toolsOf(messages[0]).map((entry) => entry.name)).toEqual([
      "wooky_overview",
      "wooky_list_threads",
      "wooky_wait",
      "wooky_read",
      "brain_ls",
      "brain_read",
      "brain_search",
    ]);
    for (const message of messages.slice(1)) {
      const result = resultOf(message);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("read-only");
    }
  });

  it("reports that Wooky is down and connects on the next call", async () => {
    const home = await tempDir("mcp-down");
    let server: RunningServer | undefined;
    cleanups.push(async () => {
      await server?.close();
      await rm(home, { recursive: true, force: true });
    });
    const session = openMcp([], { WOOKY_HOME: home });
    try {
      const down = resultOf(await session.send(tool(1, "wooky_overview")));
      expect(down.isError).toBe(true);
      expect(down.text).toBe(DOWN);
      server = await startServer({
        home,
        port: 0,
        host: "127.0.0.1",
        adapters: [createDemoAdapter({ stepMs: 0 })],
      });
      const up = resultOf(await session.send(tool(2, "wooky_overview")));
      expect(up.isError).toBe(false);
      expect(up.json).toMatchObject({ version: "0.0.0", projects: [], threads: { idle: 0 } });
    } finally {
      await session.end();
    }
  });

  it("creates in approve mode, rejects full without the flag, and accepts full with it", async () => {
    const denied = await mcp([], {}, [
      tool(1, "wooky_create_task", { projectId: "p", prompt: "x", runtimeMode: "full" }),
    ]);
    expect(resultOf(denied.messages[0]).isError).toBe(true);
    expect(resultOf(denied.messages[0]).text).toBe(
      "Start `wooky mcp --allow-full` to allow full runtime.",
    );

    const { env, projectIds, url } = await boot();
    const projectId = projectIds[0] ?? "";
    const plain = openMcp([], env);
    try {
      const created = resultOf(
        await plain.send(tool(1, "wooky_create_task", { projectId, prompt: "Add a demo note" })),
      );
      const threadId = (created.json as { threadId?: string }).threadId ?? "";
      const snap = await rpcCall(url, "snapshot", {});
      expect(snap.threads[threadId]?.runtimeMode).toBe("approve");
      expect(snap.threads[threadId]?.provider).toBe("demo");
      const waited = resultOf(
        await plain.send(tool(2, "wooky_wait", { threadId, timeoutMs: 10_000 })),
      );
      expect(waited.json).toMatchObject({
        state: "blocked",
        waitingOn: "approval",
        threadId,
      });
      expect((waited.json as { approvalId?: string }).approvalId).toBeTruthy();
    } finally {
      await plain.end();
    }

    const allowed = openMcp(["--allow-full"], env);
    try {
      const created = resultOf(
        await allowed.send(
          tool(1, "wooky_create_task", {
            projectId,
            prompt: "note",
            provider: "demo",
            model: "demo",
            runtimeMode: "full",
            isolate: false,
          }),
        ),
      );
      const threadId = (created.json as { threadId?: string }).threadId ?? "";
      const snap = await rpcCall(url, "snapshot", {});
      expect(snap.threads[threadId]?.runtimeMode).toBe("full");
    } finally {
      await allowed.end();
    }
  }, 20_000);

  it("resolves the default provider to the first available one", () => {
    const claude = agentStatus("claude", ["haiku", "sonnet"]);
    const demo = agentStatus("demo", ["demo"]);
    expect(
      resolveDefaultTarget([claude, demo], {
        disabledProviders: [],
        providers: { claude: { defaultModel: "sonnet" } },
      }),
    ).toEqual({ provider: "claude", model: "sonnet" });
    expect(resolveDefaultTarget([claude, demo], { disabledProviders: [], providers: {} })).toEqual({
      provider: "claude",
      model: "haiku",
    });
    expect(
      resolveDefaultTarget([claude, demo], { disabledProviders: ["claude"], providers: {} }),
    ).toEqual({ provider: "demo", model: "demo" });
  });

  it("rejects read, send, wait, and interrupt outside --projects", async () => {
    const { env, projectIds, url } = await boot(2);
    const [allowed, other] = projectIds;
    await rpcCall(url, "dispatch", {
      commandId: randomUUID(),
      type: "thread.create",
      projectId: other ?? "",
      provider: "demo",
      model: "demo",
      runtimeMode: "approve",
      isolate: false,
    });
    const snap = await rpcCall(url, "snapshot", {});
    const threadId =
      Object.values(snap.threads).find((thread) => thread.projectId === other)?.id ?? "";
    const session = openMcp(["--projects", allowed ?? ""], env);
    try {
      const read = resultOf(await session.send(tool(1, "wooky_read", { threadId })));
      const sent = resultOf(
        await session.send(tool(2, "wooky_send", { threadId, prompt: "later" })),
      );
      const waited = resultOf(
        await session.send(tool(3, "wooky_wait", { threadId, timeoutMs: 1000 })),
      );
      const interrupted = resultOf(await session.send(tool(4, "wooky_interrupt", { threadId })));
      for (const result of [read, sent, waited, interrupted]) {
        expect(result.isError).toBe(true);
        expect(result.text).toContain("outside");
        expect(result.text).toContain(other);
      }
    } finally {
      await session.end();
    }
  }, 20_000);

  it("drops listeners after 50 short waits", async () => {
    const home = await tempDir("mcp-hold");
    const root = await tempDir("mcp-hold-root");
    const server = await startServer({
      home,
      port: 0,
      host: "127.0.0.1",
      adapters: [holdDemo()],
    });
    cleanups.push(async () => {
      await server.close();
      await rm(home, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    });
    await rpcCall(server.url, "dispatch", {
      commandId: randomUUID(),
      type: "project.add",
      root,
      name: "held",
    });
    const snap = await rpcCall(server.url, "snapshot", {});
    const projectId =
      Object.values(snap.projects).find((project) => project.root === root)?.id ?? "";
    const session = openMcp([], { WOOKY_HOME: home });
    try {
      const created = resultOf(
        await session.send(
          tool(1, "wooky_create_task", {
            projectId,
            prompt: "hold",
            provider: "demo",
            model: "demo",
            isolate: false,
          }),
        ),
      );
      const threadId = (created.json as { threadId?: string }).threadId ?? "";
      expect(rpcSessionLoad()).toEqual({ listeners: 0, pending: 0 });
      for (let index = 0; index < 50; index += 1) {
        const waited = resultOf(
          await session.send(tool(index + 2, "wooky_wait", { threadId, timeoutMs: 20 })),
        );
        expect(waited.json).toMatchObject({ state: "timeout", threadId });
        expect(rpcSessionLoad()).toEqual({ listeners: 0, pending: 0 });
      }
    } finally {
      await session.end();
    }
  }, 20_000);

  it("truncates an oversized turn and reports a removed thread", () => {
    const encoded = formatToolResult({
      threadId: "t",
      title: "big",
      turns: [{ turnId: "u", status: "completed", text: "x".repeat(30_000) }],
      diffStat: null,
    });
    expect(encoded.length).toBeLessThanOrEqual(20_000);
    expect(JSON.parse(encoded)).toMatchObject({ note: "Truncated to 20000 characters." });
    expect(() => assertWaitingThread({ threads: {} } as ReadModel, "t1")).toThrow(
      "Thread was removed.",
    );
  });

  it("returns a parse error for a bad line and keeps reading", async () => {
    const { messages, stderr } = await mcp([], {}, ["{nope", request(7, "ping")]);
    expect(stderr).toBe("");
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(messages[1]).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});
