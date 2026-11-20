import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  WOOKY_WS_PATH,
  RpcPush,
  RpcResponse,
  type AgeEvent,
  type AgeEventOf,
  type AgeEventType,
  type PendingEvent,
  type TerminalInfo,
} from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { createDemoAdapter } from "../providers/demo/adapter.ts";
import { startServer, type RunningServer } from "../server.ts";
import { cleanupTestRepos, makeRepo } from "../git/test-repo.ts";
import type { EventStore } from "../store/event-store.ts";
import type { TerminalManager } from "../terminal/session.ts";
import { tempDir } from "../testing.ts";
import { formatSetupNotice, setupWorktree, unwatchHeldNotices } from "./worktree-setup.ts";

const posix = process.platform !== "win32";
const cleanup: (() => Promise<unknown> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
  await cleanupTestRepos();
});

describe("formatSetupNotice", () => {
  it("lists linked paths and running scripts", () => {
    expect(
      formatSetupNotice(
        { results: [], linked: [".env", "node_modules"], copied: [], skipped: [] },
        ["Install"],
      ),
    ).toBe("Setting up worktree: linked .env, node_modules; running Install");
  });
});

async function connect(server: RunningServer) {
  const socket = new WebSocket(`${server.url.replace("http", "ws")}${WOOKY_WS_PATH}`);
  cleanup.push(() => socket.close());
  const pending = new Map<number, (response: RpcResponse) => void>();
  const pushes: AgeEvent[] = [];
  const waiters: { match: (e: AgeEvent) => boolean; resolve: (e: AgeEvent) => void }[] = [];
  socket.on("message", (data) => {
    const message: unknown = JSON.parse(String(data));
    const push = RpcPush.safeParse(message);
    if (push.success) {
      if (push.data.push === "event") {
        const event = push.data.event;
        pushes.push(event);
        for (const waiter of waiters.splice(0)) {
          if (waiter.match(event)) waiter.resolve(event);
          else waiters.push(waiter);
        }
      }
      return;
    }
    const response = RpcResponse.safeParse(message);
    if (response.success) pending.get(response.data.id)?.(response.data);
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
    call,
    dispatch: (command: Record<string, unknown>) =>
      call<{ accepted: boolean }>("dispatch", {
        commandId: `script-${Date.now()}-${++commandCounter}`,
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

describe("held setup notices", () => {
  function harness() {
    const listeners = new Set<(events: readonly AgeEvent[]) => void>();
    const appended: PendingEvent[] = [];
    const store: EventStore = {
      get model() {
        return emptyReadModel();
      },
      commit() {
        throw new Error("not used");
      },
      appendInternal(events) {
        appended.push(...events);
        return [];
      },
      receipt() {
        return null;
      },
      eventsAfter() {
        return [];
      },
      markEffect() {},
      pendingEffects() {
        return [];
      },
      appendReplicaEvents() {
        return 0;
      },
      replicaEventsAfter() {
        return [];
      },
      replicaHighWater() {
        return 0;
      },
      replicaOwners() {
        return [];
      },
      dropReplicaOwner() {
        return 0;
      },
      dropReplicaThreads() {
        return 0;
      },
      claimCheckpoints() {
        return [];
      },
      markClaimReleased() {},
      isClaimReleased() {
        return false;
      },
      clearClaimReleased() {},
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        listeners.clear();
      },
    };
    return {
      store,
      appended,
      listenerCount: () => listeners.size,
      fire(events: AgeEvent[]) {
        for (const listener of [...listeners]) listener(events);
      },
    };
  }

  const started = (threadId: string, turnId: string): AgeEvent =>
    ({
      type: "turn.started",
      threadId,
      turnId,
      prompt: "Say ok",
      provider: "demo",
      model: "demo",
      checkpointBefore: null,
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
    }) as unknown as AgeEvent;

  const removed = (threadId: string): AgeEvent =>
    ({
      type: "thread.removed",
      threadId,
      seq: 2,
      at: "2026-01-01T00:00:01.000Z",
    }) as unknown as AgeEvent;

  it("subscribes once, holds at most 200 threads, and forgets removed ones", async () => {
    const held = harness();
    const projectRoot = await mkdtemp(join(tmpdir(), "wooky-held-project-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "wooky-held-worktree-"));
    cleanup.push(() => rm(projectRoot, { recursive: true, force: true }));
    cleanup.push(() => rm(worktreePath, { recursive: true, force: true }));
    const terminals = {
      open: async () => {
        throw new Error("no setup commands in this test");
      },
    } as unknown as TerminalManager;

    for (let i = 0; i < 300; i += 1) {
      await setupWorktree({
        threadId: `thread-${i}`,
        projectRoot,
        worktree: { path: worktreePath, branch: "main" },
        store: held.store,
        terminals,
        newId: (prefix) => `${prefix}-${i}`,
      });
    }
    expect(held.listenerCount()).toBe(1);

    // The oldest threads were evicted to make room for the newest.
    held.fire([started("thread-0", "turn-0")]);
    expect(held.appended).toHaveLength(0);

    held.fire([started("thread-250", "turn-250")]);
    expect(held.appended).toEqual([
      expect.objectContaining({
        type: "turn.itemUpserted",
        threadId: "thread-250",
        turnId: "turn-250",
        item: { kind: "notice", id: "notice-250", text: "Setting up worktree" },
      }),
    ]);
    expect(held.listenerCount()).toBe(1);

    // A thread removed before its first turn takes its notice with it.
    held.fire([removed("thread-251")]);
    held.fire([started("thread-251", "turn-251")]);
    expect(held.appended).toHaveLength(1);
    expect(held.listenerCount()).toBe(1);

    unwatchHeldNotices();
    expect(held.listenerCount()).toBe(0);
  });
});

describe("worktree setup hook", () => {
  it.skipIf(!posix)(
    "links shared paths and starts setup when an isolated demo thread is created",
    async () => {
      const root = await makeRepo();
      await writeFile(join(root, ".gitignore"), ".env\n");
      await writeFile(join(root, ".env"), "SECRET=1\n");
      const home = await tempDir("scripts-wt-home");
      cleanup.push(() => rm(home, { recursive: true, force: true }));
      const server = await startServer({
        home,
        port: 0,
        host: "127.0.0.1",
        adapters: [createDemoAdapter({ stepMs: 0 })],
      });
      cleanup.push(() => server.close());
      const client = await connect(server);
      await client.call("subscribe", { fromSeq: 0 });
      await client.dispatch({ type: "project.add", root });
      const project = (await client.next("project.added")).project;
      await client.dispatch({
        type: "project.configure",
        projectId: project.id,
        settings: {
          scripts: [
            {
              id: "install",
              name: "Install",
              command: "echo installed",
              runOnWorktreeCreate: true,
            },
          ],
          sharedPaths: [
            { path: ".env", mode: "link" },
            { path: "missing.env", mode: "link" },
          ],
          worktreeSetup: "echo setup-done",
          prompts: [],
        },
      });
      await client.next("project.configured");
      await client.dispatch({
        type: "thread.create",
        projectId: project.id,
        provider: "demo",
        model: "demo",
        runtimeMode: "full",
        isolate: true,
      });
      const threadId = (await client.next("thread.created")).thread.id;
      const { worktree } = await client.next(
        "thread.worktreeBound",
        (event) => event.threadId === threadId,
      );
      const envLink = join(worktree.path, ".env");
      for (let i = 0; i < 200; i += 1) {
        try {
          if ((await lstat(envLink)).isSymbolicLink()) break;
        } catch {
          // still applying
        }
        await client.call("providers.list");
      }
      expect((await lstat(envLink)).isSymbolicLink()).toBe(true);

      let setup: TerminalInfo | undefined;
      let scriptSetup: TerminalInfo | undefined;
      for (let i = 0; i < 200; i += 1) {
        const listed = await client.call<TerminalInfo[]>("terminal.list");
        setup = listed.find((session) => session.title === "Setup");
        scriptSetup = listed.find((session) => session.title === "Setup: Install");
        if (setup && scriptSetup) break;
        await client.call("providers.list");
      }
      expect(setup?.title).toBe("Setup");
      expect(scriptSetup?.title).toBe("Setup: Install");

      // The notice has no turn to live on until the first turn starts.
      await client.dispatch({ type: "turn.start", threadId, prompt: "Say ok" });
      const notice = await client.next(
        "turn.itemUpserted",
        (event) => event.threadId === threadId && event.item.kind === "notice",
      );
      expect(notice.item).toMatchObject({
        kind: "notice",
        text: expect.stringMatching(
          /^Setting up worktree: linked \.env; skipped missing\.env; running Setup, Install$/,
        ),
      });
      await client.next("turn.finished", (event) => event.threadId === threadId);
    },
  );
});
