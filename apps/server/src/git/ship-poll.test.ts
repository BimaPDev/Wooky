import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, Thread } from "@wooky/contracts";
import { openEventStore } from "../store/event-store.ts";
import { tempDir } from "../testing.ts";
import type { GhClient } from "./gh.ts";
import { createShipService } from "./ship.ts";
import { createGitService } from "./service.ts";

function openThread(id: string, pr: PullRequest): Thread {
  return {
    id,
    projectId: "p1",
    title: "poll",
    provider: "demo",
    model: "demo",
    runtimeMode: "full",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    isolate: false,
    worktree: null,
    providerSessionId: null,
    ownerDeviceId: null,
    movedTo: null,
    movedFrom: null,
    pullRequest: pr,
    queue: [],
  };
}

describe("ship PR poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not overlap ticks", async () => {
    const home = await tempDir("poll-overlap");
    const store = openEventStore(home, () => "2026-01-01T00:00:00.000Z");
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gh: GhClient = {
      available: () => true,
      authStatus: async () => true,
      async run() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await blocked;
        active -= 1;
        return {
          stdout: JSON.stringify({
            url: "https://github.com/x/y/pull/1",
            number: 1,
            state: "OPEN",
            headRefName: "main",
          }),
          stderr: "",
          code: 0,
        };
      },
      mapPrView(json) {
        return { url: json.url, number: json.number, state: "open", branch: json.headRefName };
      },
    };
    store.appendInternal([
      {
        type: "project.added",
        commandId: null,
        project: {
          id: "p1",
          name: "demo",
          root: "/tmp",
          createdAt: "2026-01-01T00:00:00.000Z",
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
      },
      {
        type: "thread.created",
        commandId: null,
        thread: openThread("t1", {
          url: "https://github.com/x/y/pull/1",
          number: 1,
          state: "open",
          branch: "main",
        }),
      },
    ]);
    const ship = createShipService({ store, git: createGitService(), gh, pollMs: 100 });
    const stop = ship.startPolling();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    release?.();
    await blocked;
    stop();
    expect(maxActive).toBeLessThanOrEqual(1);
    store.close();
  });

  it("skips gh calls when unauthed", async () => {
    const home = await tempDir("poll-unauth");
    const store = openEventStore(home, () => "2026-01-01");
    let ghCalls = 0;
    const gh: GhClient = {
      available: () => true,
      authStatus: async () => false,
      async run() {
        ghCalls += 1;
        return { stdout: "", stderr: "", code: 0 };
      },
      mapPrView(json) {
        return { url: json.url, number: json.number, state: "open", branch: json.headRefName };
      },
    };
    store.appendInternal([
      {
        type: "project.added",
        commandId: null,
        project: {
          id: "p1",
          name: "demo",
          root: "/tmp",
          createdAt: "2026-01-01T00:00:00.000Z",
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
      },
      {
        type: "thread.created",
        commandId: null,
        thread: openThread("t1", {
          url: "https://github.com/x/y/pull/1",
          number: 1,
          state: "open",
          branch: "main",
        }),
      },
    ]);
    const ship = createShipService({ store, git: createGitService(), gh, pollMs: 100 });
    const stop = ship.startPolling();
    await vi.advanceTimersByTimeAsync(250);
    stop();
    expect(ghCalls).toBe(0);
    store.close();
  });

  it("does not append after stop", async () => {
    const home = await tempDir("poll-stop");
    const store = openEventStore(home, () => "2026-01-01");
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gh: GhClient = {
      available: () => true,
      authStatus: async () => true,
      async run() {
        await hang;
        return {
          stdout: JSON.stringify({
            url: "https://github.com/x/y/pull/1",
            number: 1,
            state: "MERGED",
            headRefName: "main",
            mergedAt: "2026-01-01T01:00:00.000Z",
          }),
          stderr: "",
          code: 0,
        };
      },
      mapPrView(json) {
        return { url: json.url, number: json.number, state: "merged", branch: json.headRefName };
      },
    };
    store.appendInternal([
      {
        type: "project.added",
        commandId: null,
        project: {
          id: "p1",
          name: "demo",
          root: "/tmp",
          createdAt: "2026-01-01T00:00:00.000Z",
          settings: { scripts: [], sharedPaths: [], prompts: [] },
        },
      },
      {
        type: "thread.created",
        commandId: null,
        thread: openThread("t1", {
          url: "https://github.com/x/y/pull/1",
          number: 1,
          state: "open",
          branch: "main",
        }),
      },
    ]);
    const before = store.model.seq;
    const ship = createShipService({ store, git: createGitService(), gh, pollMs: 100 });
    const stop = ship.startPolling();
    await vi.advanceTimersByTimeAsync(100);
    stop();
    release?.();
    await hang;
    await Promise.resolve();
    expect(store.model.seq).toBe(before);
    store.close();
  });
});
