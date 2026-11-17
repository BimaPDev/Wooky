import { beforeEach, describe, expect, it } from "vitest";
import { runInTerminal, takePendingTerminalLine } from "./actions.ts";
import { useStore } from "./store.ts";

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
