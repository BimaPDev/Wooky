import type { AgeEvent, RpcMethod, RpcParams, RpcResult, Thread } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBackend } from "./backend.ts";
import {
  closeSettings,
  navHistoryBack,
  navHistoryForward,
  openSettings,
  pickProjectFolder,
  selectThread,
  signInOpenedCopy,
} from "./actions.ts";
import { receiveEvent, useStore } from "./store.ts";

function seedThreads(...ids: string[]) {
  const threads: Record<string, Thread> = {};
  for (const id of ids)
    threads[id] = { id, projectId: "p", updatedAt: "2026-01-01T00:00:00.000Z" } as Thread;
  useStore.setState({
    model: { ...emptyReadModel(), threads },
    selectedThreadId: null,
    settingsOpen: false,
    settingsPage: "general",
    nav: { past: [], future: [] },
    navSilent: false,
  });
}

let seq = 0;
const removed = (threadId: string) =>
  ({
    type: "thread.removed",
    commandId: `rm-${threadId}`,
    threadId,
    seq: ++seq,
    at: "2026-01-02T00:00:00.000Z",
  }) as AgeEvent;

describe("nav history actions", () => {
  beforeEach(() => seedThreads("a", "b", "c"));

  it("lets Back reopen Settings after it was closed, and Forward return to the thread", () => {
    selectThread("a");
    openSettings("appearance");
    closeSettings();
    expect(useStore.getState()).toMatchObject({ settingsOpen: false, selectedThreadId: "a" });

    navHistoryBack();
    expect(useStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "appearance" });

    navHistoryForward();
    expect(useStore.getState()).toMatchObject({ settingsOpen: false, selectedThreadId: "a" });
  });

  it("strips removed threads from both stacks", () => {
    selectThread("a");
    selectThread("b");
    selectThread("c");
    navHistoryBack(); // at b, future [c]
    receiveEvent(removed("a"));
    receiveEvent(removed("c"));
    const { nav } = useStore.getState();
    expect(nav.past).toEqual([{ kind: "thread", threadId: null }]);
    expect(nav.future).toEqual([]);
  });

  it("skips targets whose thread no longer exists", () => {
    selectThread("a");
    selectThread("b");
    selectThread("c");
    // Simulate a stale stack entry by dropping b from the model without an event.
    const { b: _gone, ...threads } = useStore.getState().model.threads;
    useStore.setState((state) => ({ model: { ...state.model, threads } }));
    navHistoryBack();
    expect(useStore.getState().selectedThreadId).toBe("a");
  });
});

describe("sign-in copy", () => {
  it("names the command the server opened and points at Refresh", () => {
    expect(signInOpenedCopy("agent login")).toBe(
      "Opened Terminal to run `agent login`. Finish signing in there, then press Refresh.",
    );
    expect(signInOpenedCopy("claude auth login")).toBe(
      "Opened Terminal to run `claude auth login`. Finish signing in there, then press Refresh.",
    );
    expect(signInOpenedCopy("codex login")).toBe(
      "Opened Terminal to run `codex login`. Finish signing in there, then press Refresh.",
    );
  });
});

const calls: Array<{ method: string; params: unknown }> = [];

function unarmedPick(): void {
  throw new Error("The folder picker gate was not armed.");
}

function useBackend(respond: (method: RpcMethod, params: unknown) => unknown) {
  setBackend({
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) =>
      Promise.resolve(respond(method, params)).then((result) => result as RpcResult<M>),
  });
}

function installBridge(pickFolder: (() => Promise<string | null>) | null) {
  if (!pickFolder) {
    delete (globalThis as { window?: unknown }).window;
    return;
  }
  (globalThis as unknown as { window: { wooky: WookyShell } }).window = {
    wooky: {
      platform: "darwin",
      versions: { electron: "0", chrome: "0", node: "24" },
      pickFolder,
    },
  };
}

describe("pickProjectFolder", () => {
  beforeEach(() => {
    calls.length = 0;
    installBridge(null);
    useStore.setState({
      dialog: null,
      notice: null,
      pickingFolder: false,
      paletteOpen: true,
      model: emptyReadModel(),
    });
  });

  afterEach(() => installBridge(null));

  it("adds the folder the desktop bridge returns", async () => {
    installBridge(async () => "/Users/demo/app");
    useBackend((method, params) => {
      calls.push({ method, params });
      if (method === "dispatch") return { accepted: true, duplicate: false, seq: 1 };
      throw new Error(`unexpected ${method}`);
    });

    await pickProjectFolder();

    expect(calls.map((call) => call.method)).toEqual(["dispatch"]);
    expect(calls[0]?.params).toMatchObject({ type: "project.add", root: "/Users/demo/app" });
    expect(useStore.getState().dialog).toBeNull();
    expect(useStore.getState().pickingFolder).toBe(false);
  });

  it("asks the server when the desktop bridge is absent", async () => {
    useBackend((method, params) => {
      calls.push({ method, params });
      if (method === "fs.pickFolder") return { path: "/Users/demo/rpc", supported: true };
      if (method === "dispatch") return { accepted: true, duplicate: false, seq: 1 };
      throw new Error(`unexpected ${method}`);
    });

    await pickProjectFolder();

    expect(calls.map((call) => call.method)).toEqual(["fs.pickFolder", "dispatch"]);
    expect(calls[1]?.params).toMatchObject({ type: "project.add", root: "/Users/demo/rpc" });
  });

  it("opens the path dialog when no native chooser is available", async () => {
    useBackend((method) => {
      calls.push({ method, params: {} });
      if (method === "fs.pickFolder") return { path: null, supported: false };
      throw new Error(`unexpected ${method}`);
    });

    await pickProjectFolder();

    expect(useStore.getState().dialog).toEqual({ kind: "addProject" });
    expect(calls.map((call) => call.method)).toEqual(["fs.pickFolder"]);
  });

  it("does nothing when the chooser is cancelled", async () => {
    installBridge(async () => null);
    useBackend((method) => {
      calls.push({ method, params: {} });
      throw new Error(`unexpected ${method}`);
    });

    await pickProjectFolder();

    expect(calls).toEqual([]);
    expect(useStore.getState().dialog).toBeNull();
    expect(useStore.getState().notice).toBeNull();
  });

  it("shows addProject failures on the notice bar", async () => {
    useBackend((method) => {
      if (method === "fs.pickFolder") return { path: "/tmp/app", supported: true };
      throw new Error("/tmp/app is already a project.");
    });

    await pickProjectFolder();

    expect(useStore.getState().notice).toBe("/tmp/app is already a project.");
    expect(useStore.getState().dialog).toBeNull();
  });

  it("ignores a second request while the chooser is open", async () => {
    const pending: { resolve: (path: string | null) => void; promise: Promise<string | null> } = {
      resolve: unarmedPick,
      promise: Promise.resolve(null),
    };
    pending.promise = new Promise((resolve) => {
      pending.resolve = resolve;
    });
    let picks = 0;
    installBridge(() => {
      picks += 1;
      return pending.promise;
    });
    useBackend((method, params) => {
      calls.push({ method, params });
      return { accepted: true, duplicate: false, seq: 1 };
    });

    const first = pickProjectFolder();
    const second = pickProjectFolder();
    expect(useStore.getState().pickingFolder).toBe(true);
    expect(picks).toBe(1);
    pending.resolve("/Users/demo/app");
    await first;
    await second;
    expect(calls).toHaveLength(1);
    expect(useStore.getState().pickingFolder).toBe(false);
  });

  it("opens the path dialog when the chooser fails", async () => {
    installBridge(async () => {
      throw new Error("The folder chooser timed out.");
    });
    useBackend(() => {
      throw new Error("unexpected");
    });

    await pickProjectFolder();

    expect(useStore.getState().notice).toBe("The folder chooser timed out.");
    expect(useStore.getState().dialog).toEqual({ kind: "addProject" });
  });

  it("does not open a chooser while another dialog is open", async () => {
    useStore.setState({ dialog: { kind: "addProject" } });
    let picks = 0;
    installBridge(async () => {
      picks += 1;
      return "/Users/demo/app";
    });
    useBackend(() => {
      throw new Error("unexpected");
    });

    await pickProjectFolder();

    expect(picks).toBe(0);
    expect(useStore.getState().dialog).toEqual({ kind: "addProject" });
    expect(useStore.getState().pickingFolder).toBe(false);
  });
});
