import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AGE_WS_PATH, type AgeEvent, RpcPush, RpcResponse } from "@age/contracts";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer, type ServerOptions } from "../server.ts";
import { openEventStore } from "../store/event-store.ts";
import { createFakeGit, tempDir } from "../testing.ts";
import { originAllowed } from "./ws.ts";

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
});

async function boot(options: Partial<ServerOptions> = {}) {
  const userHome = await tempDir("user");
  const home = await tempDir("home");
  await mkdir(join(userHome, "code"));
  await mkdir(join(userHome, "code", ".git"));
  await mkdir(join(userHome, "notes"));
  await mkdir(join(userHome, ".hidden"));
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    userHome,
    adapters: [createDemoAdapter({ stepMs: 0 })],
    ...options,
  });
  servers.push(server);
  return { server, userHome, home };
}

async function connect(server: RunningServer) {
  const socket = new WebSocket(`${server.url.replace("http", "ws")}${AGE_WS_PATH}`);
  sockets.push(socket);
  const pending = new Map<number, (response: RpcResponse) => void>();
  const pushes: AgeEvent[] = [];
  const waiters: { match: (event: AgeEvent) => boolean; resolve: (event: AgeEvent) => void }[] = [];
  socket.on("message", (data) => {
    const message: unknown = JSON.parse(String(data));
    const push = RpcPush.safeParse(message);
    if (push.success && push.data.push === "event") {
      const event = push.data.event;
      pushes.push(event);
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(event)) waiter.resolve(event);
        else waiters.push(waiter);
      }
      return;
    }
    const response = RpcResponse.parse(message);
    pending.get(response.id)?.(response);
  });
  await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));

  let nextId = 0;
  return {
    pushes,
    call(method: string, params: unknown = {}): Promise<RpcResponse> {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    nextPush(match: (event: AgeEvent) => boolean): Promise<AgeEvent> {
      const seen = pushes.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

function rejectedUpgrade(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    sockets.push(socket);
    socket.once("open", () => reject(new Error("upgrade was accepted")));
    socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.once("error", () => {});
  });
}

describe("transport", () => {
  it("serves a snapshot, records commands and pushes their events", async () => {
    const { server, userHome } = await boot();
    const client = await connect(server);

    expect(await client.call("snapshot")).toEqual({
      id: 1,
      ok: true,
      result: { seq: 0, projects: {}, threads: {}, turns: {} },
    });
    expect(await client.call("subscribe", { fromSeq: 0 })).toMatchObject({
      ok: true,
      result: { replayed: 0 },
    });

    const root = join(userHome, "code");
    const add = { type: "project.add", commandId: "c1", root };
    expect(await client.call("dispatch", add)).toMatchObject({
      ok: true,
      result: { accepted: true, duplicate: false, seq: 1 },
    });
    expect(await client.nextPush((event) => event.type === "project.added")).toMatchObject({
      seq: 1,
      commandId: "c1",
      project: { root, name: "code" },
    });

    expect(await client.call("dispatch", add)).toMatchObject({
      ok: true,
      result: { accepted: true, duplicate: true, seq: 1 },
    });
    expect(client.pushes).toHaveLength(1);

    const late = await connect(server);
    expect(await late.call("subscribe", { fromSeq: 0 })).toMatchObject({
      result: { replayed: 1 },
    });
    expect(late.pushes.map((event) => event.seq)).toEqual([1]);
  });

  it("runs a demo turn end to end", async () => {
    const fake = createFakeGit({ changed: ["AGE_DEMO.md"] });
    const { server, userHome } = await boot({ git: fake.git });
    const client = await connect(server);
    await client.call("subscribe", { fromSeq: 0 });
    await client.call("dispatch", { type: "project.add", commandId: "c1", root: userHome });
    const project = await client.nextPush((event) => event.type === "project.added");
    if (project.type !== "project.added") throw new Error("unreachable");
    await client.call("dispatch", {
      type: "thread.create",
      commandId: "c2",
      projectId: project.project.id,
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: false,
    });
    const thread = await client.nextPush((event) => event.type === "thread.created");
    if (thread.type !== "thread.created") throw new Error("unreachable");
    await client.call("dispatch", {
      type: "turn.start",
      commandId: "c3",
      threadId: thread.thread.id,
      prompt: "Hello",
    });
    expect(await client.nextPush((event) => event.type === "turn.finished")).toMatchObject({
      status: "completed",
    });
    expect(await client.call("git.diff", { threadId: thread.thread.id })).toMatchObject({
      ok: true,
      result: [{ path: "AGE_DEMO.md", status: "modified" }],
    });
    expect(fake.calls.at(-1)).toMatch(/^diff refs\/age\/checkpoints\/.+\/before null$/);
  });

  it("refuses dispatches while shutting down and finishes the running turn", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const { server, userHome, home } = await boot({
      adapters: [
        {
          kind: "demo",
          probe: () => Promise.reject(new Error("not probed")),
          async *runTurn(input) {
            started();
            await new Promise((resolve) => input.signal.addEventListener("abort", resolve));
            await released;
            yield { type: "done", status: "interrupted", error: null };
          },
        },
      ],
    });
    const client = await connect(server);
    await client.call("dispatch", { type: "project.add", commandId: "c1", root: userHome });
    const projectId = Object.keys(
      ((await client.call("snapshot")) as { result: { projects: object } }).result.projects,
    )[0];
    const thread = {
      type: "thread.create",
      projectId,
      provider: "demo",
      model: "demo",
      runtimeMode: "full",
      isolate: false,
    };
    await client.call("dispatch", { ...thread, commandId: "c2" });
    const snapshot = (await client.call("snapshot")) as { result: { threads: object } };
    const threadId = Object.keys(snapshot.result.threads)[0];
    await client.call("dispatch", { type: "turn.start", commandId: "c3", threadId, prompt: "Go" });
    await running;

    const closing = server.close();
    expect(await client.call("dispatch", { ...thread, commandId: "c4" })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    release();
    await closing;

    const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
    expect(store.receipt("c4")).toBeNull();
    expect(Object.keys(store.model.threads)).toEqual([threadId]);
    const finished = store.eventsAfter(0).filter((event) => event.type === "turn.finished");
    expect(finished).toMatchObject([{ threadId, status: "interrupted" }]);
    store.close();
  });

  it("maps bad input and rejections to RPC error codes", async () => {
    const { server } = await boot();
    const client = await connect(server);
    expect(await client.call("dispatch", { type: "project.add", commandId: "c1" })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await client.call("nope")).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await client.call("subscribe", { fromSeq: -1 })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(
      await client.call("dispatch", { type: "project.remove", commandId: "c2", projectId: "x" }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.call("git.diff", { threadId: "x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("lists providers and pickable directories", async () => {
    const { server, userHome } = await boot();
    const client = await connect(server);
    expect(await client.call("providers.list")).toMatchObject({
      ok: true,
      result: [{ kind: "demo", installed: true, authenticated: true }],
    });
    expect(await client.call("fs.pickable")).toEqual({
      id: 2,
      ok: true,
      result: [
        { path: join(userHome, "code"), isGitRepo: true },
        { path: join(userHome, "notes"), isGitRepo: false },
      ],
    });
    expect(await client.call("fs.pickable", { query: "NOT" })).toMatchObject({
      result: [{ path: join(userHome, "notes") }],
    });
  });

  it("rejects WebSocket upgrades from foreign origins", async () => {
    const { server } = await boot();
    const url = `${server.url.replace("http", "ws")}${AGE_WS_PATH}`;
    expect(await rejectedUpgrade(url, "http://evil.example")).toBe(403);
    const local = new WebSocket(url, { origin: "http://localhost:5173" });
    sockets.push(local);
    await new Promise((resolve, reject) => local.once("open", resolve).once("error", reject));
  });

  it("decides origins by host", () => {
    expect(originAllowed(undefined, "127.0.0.1:4317")).toBe(true);
    expect(originAllowed("http://127.0.0.1:9", "127.0.0.1:4317")).toBe(true);
    expect(originAllowed("http://[::1]:9", "[::1]:4317")).toBe(true);
    expect(originAllowed("http://box.lan:4317", "box.lan:4317")).toBe(false);
    expect(originAllowed("http://box.lan:4317", "box.lan:4317", new Set(["box.lan"]))).toBe(true);
    // DNS rebinding: hostile name resolving to loopback, page and Host both say evil.example.
    expect(originAllowed("http://evil.example:4317", "evil.example:4317")).toBe(false);
    // Local page dialling a non-local Host is refused too.
    expect(originAllowed("http://127.0.0.1:5173", "evil.example:4317")).toBe(false);
    expect(originAllowed("http://evil.example", "127.0.0.1:4317")).toBe(false);
    expect(originAllowed("not a url", "x")).toBe(false);
  });

  it("serves health and the web build with an SPA fallback", async () => {
    const webDist = await tempDir("web");
    await writeFile(join(webDist, "index.html"), "<!doctype html><title>AGE</title>");
    await writeFile(join(webDist, "app.js"), "console.info(1)");
    const { server } = await boot({ webDist });

    const health = await fetch(`${server.url}/healthz`);
    expect([health.status, await health.text()]).toEqual([200, "ok"]);
    const script = await fetch(`${server.url}/app.js`);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const route = await fetch(`${server.url}/threads/abc`);
    expect(route.headers.get("content-type")).toContain("text/html");
    expect(await route.text()).toContain("<title>AGE</title>");
    expect((await fetch(`${server.url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${server.url}/..%2f..%2fetc%2fhosts.txt`)).status).toBe(404);
  });
});
