// Head-chef integration test: the whole user journey across stations, with a real
// server, real WebSocket, real git and the demo agent. Nothing here is faked.
// age-allow child-process: the fixture builds a real git repo to test against.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  AGE_WS_PATH,
  RpcPush,
  RpcResponse,
  type AgeEvent,
  type AgeEventOf,
  type AgeEventType,
  type FileDiff,
  type ReadModel,
} from "@age/contracts";
import { createDemoAdapter } from "./providers/demo/adapter.ts";
import { startServer, type RunningServer } from "./server.ts";
import { tempDir } from "./testing.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

async function makeRepo(): Promise<string> {
  const root = await tempDir("e2e-repo");
  cleanup.push(() => rm(join(root, "..", ".age-worktrees"), { recursive: true, force: true }));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hello\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

async function boot(home: string): Promise<RunningServer> {
  const server = await startServer({
    home,
    port: 0,
    host: "127.0.0.1",
    adapters: [createDemoAdapter({ stepMs: 0 })],
  });
  cleanup.push(() => server.close());
  return server;
}

async function connect(server: RunningServer) {
  const socket = new WebSocket(`${server.url.replace("http", "ws")}${AGE_WS_PATH}`);
  cleanup.push(() => socket.close());
  const pending = new Map<number, (response: RpcResponse) => void>();
  const pushes: AgeEvent[] = [];
  const waiters: { match: (e: AgeEvent) => boolean; resolve: (e: AgeEvent) => void }[] = [];
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
  async function call<T>(method: string, params: unknown = {}): Promise<T> {
    const id = ++nextId;
    const response = await new Promise<RpcResponse>((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (!response.ok)
      throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
    return response.result as T;
  }
  let commandCounter = 0;
  return {
    pushes,
    call,
    dispatch: (command: Record<string, unknown>) =>
      call<{ accepted: boolean }>("dispatch", {
        commandId: `e2e-${Date.now()}-${++commandCounter}`,
        ...command,
      }),
    next<T extends AgeEventType>(
      type: T,
      match: (e: AgeEventOf<T>) => boolean = () => true,
    ): Promise<AgeEventOf<T>> {
      const ok = (e: AgeEvent): e is AgeEventOf<T> => e.type === type && match(e as AgeEventOf<T>);
      const seen = pushes.find(ok);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) =>
        waiters.push({ match: ok, resolve: (e) => resolve(e as AgeEventOf<T>) }),
      );
    },
  };
}

describe("end-to-end: isolated demo turn with approvals, diff, revert, restart", () => {
  it("runs the whole journey against real git", async () => {
    const root = await makeRepo();
    const home = await tempDir("e2e-home");
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const headBefore = git(root, "rev-parse", "HEAD");

    const server = await boot(home);
    const client = await connect(server);
    await client.call("subscribe", { fromSeq: 0 });

    // Providers are probed through the registry.
    const providers = await client.call<{ kind: string; installed: boolean }[]>("providers.list");
    expect(providers.find((p) => p.kind === "demo")?.installed).toBe(true);

    await client.dispatch({ type: "project.add", root });
    const project = (await client.next("project.added")).project;

    await client.dispatch({
      type: "thread.create",
      projectId: project.id,
      provider: "demo",
      model: "demo",
      runtimeMode: "approve",
      isolate: true,
    });
    const threadId = (await client.next("thread.created")).thread.id;
    const { worktree } = await client.next("thread.worktreeBound", (e) => e.threadId === threadId);
    expect(existsSync(worktree.path)).toBe(true);
    expect(worktree.branch).toBe(`age/${threadId}`);

    // Answer every approval card with "allow" until the turn finishes.
    const answered = new Set<string>();
    const approve = (event: AgeEvent) => {
      if (event.type !== "approval.requested" || answered.has(event.requestId)) return;
      answered.add(event.requestId);
      void client.dispatch({
        type: "approval.respond",
        threadId,
        requestId: event.requestId,
        decision: "allow",
      });
    };
    const finished = (async () => {
      for (;;) {
        const event = await client.next(
          "approval.requested",
          (e) => e.threadId === threadId && !answered.has(e.requestId),
        );
        approve(event);
      }
    })();
    void finished;

    await client.dispatch({ type: "turn.start", threadId, prompt: "Add a demo note" });
    const done = await client.next("turn.finished", (e) => e.threadId === threadId);
    expect(done.status).toBe("completed");
    expect(answered.size).toBeGreaterThan(0);
    expect(done.changedFiles).toContain("AGE_DEMO.md");
    expect(done.checkpointAfter).toMatch(/^refs\/age\/checkpoints\//);

    // Isolation: the edit lives in the worktree only; the user's checkout is untouched.
    expect(existsSync(join(worktree.path, "AGE_DEMO.md"))).toBe(true);
    expect(existsSync(join(root, "AGE_DEMO.md"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(root, "branch", "--show-current")).toBe("main");

    // Diff for the thread shows the demo file.
    const diff = await client.call<FileDiff[]>("git.diff", { threadId });
    expect(diff.find((f) => f.path === "AGE_DEMO.md")?.status).toBe("added");

    // A second client sees the same state from a snapshot.
    const other = await connect(server);
    const snapshot = await other.call<ReadModel>("snapshot");
    expect(snapshot.turns[threadId]?.[0]?.status).toBe("completed");

    // Revert restores the worktree to before the turn and drops the turn.
    const turnId = done.turnId;
    await client.dispatch({ type: "turn.revert", threadId, turnId });
    await client.next("turn.reverted", (e) => e.turnId === turnId);
    expect(existsSync(join(worktree.path, "AGE_DEMO.md"))).toBe(false);
    expect(readFileSync(join(worktree.path, "README.md"), "utf8")).toBe("hello\n");

    // Restart with the same home: state is rebuilt from the event log.
    const seqBefore = (await client.call<ReadModel>("snapshot")).seq;
    await server.close();
    const restarted = await boot(home);
    const again = await connect(restarted);
    const reloaded = await again.call<ReadModel>("snapshot");
    expect(reloaded.seq).toBe(seqBefore);
    expect(reloaded.threads[threadId]?.worktree?.path).toBe(worktree.path);
    expect(reloaded.turns[threadId]).toEqual([]);

    // Removing the thread removes its worktree but keeps the branch.
    await again.call("subscribe", { fromSeq: reloaded.seq });
    await again.dispatch({ type: "thread.remove", threadId });
    await again.next("thread.removed", (e) => e.threadId === threadId);
    await waitUntilGone(worktree.path, again);
    expect(git(root, "branch", "--list", `age/${threadId}`)).toContain(`age/${threadId}`);
  });
});

/** Worktree removal is an effect after the event; probe via a cheap RPC round-trip each time. */
async function waitUntilGone(path: string, client: Awaited<ReturnType<typeof connect>>) {
  for (let i = 0; i < 5000 && existsSync(path); i++) await client.call("providers.list");
  expect(existsSync(path)).toBe(false);
}
