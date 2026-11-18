import type { AgeEvent, Thread } from "@age/contracts";
import { emptyReadModel } from "@age/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  closeSettings,
  navHistoryBack,
  navHistoryForward,
  openSettings,
  runInTerminal,
  selectThread,
  takePendingTerminalLine,
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

describe("pending terminal line", () => {
  beforeEach(() => useStore.setState({ pendingTerminalLine: null }));

  it("hands a line queued while a shell is ready to it exactly once", () => {
    runInTerminal("claude auth login");
    expect(takePendingTerminalLine("session-1")).toBe("claude auth login");
    expect(takePendingTerminalLine("session-1")).toBeNull();
  });

  it("keeps a line queued before the shell is ready until it is", () => {
    runInTerminal("codex login");
    expect(takePendingTerminalLine(null)).toBeNull();
    expect(useStore.getState().pendingTerminalLine).toBe("codex login");
    expect(takePendingTerminalLine("session-2")).toBe("codex login");
  });

  it("gives a double take nothing the second time", () => {
    runInTerminal("agent login");
    const first = takePendingTerminalLine("session-1");
    const second = takePendingTerminalLine("session-1");
    expect([first, second]).toEqual(["agent login", null]);
  });
});
