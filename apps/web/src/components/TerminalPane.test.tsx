/**
 * @vitest-environment happy-dom
 */
import type { RpcMethod, RpcParams, RpcResult, TerminalInfo } from "@wooky/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../state/backend.ts";
import { useStore } from "../state/store.ts";
import { receiveTerminal } from "../state/terminal.ts";
import { TerminalPane, terminalLine } from "./TerminalPane.tsx";

vi.mock("./terminal/xterm-styles.ts", () => ({ xtermStyles: true }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    options: {
      theme?: unknown;
      fontFamily?: string;
      fontSize?: number;
      disableStdin?: boolean;
    } = {};
    open() {}
    loadAddon() {}
    write() {}
    reset() {}
    dispose() {}
    focus() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    activate() {}
    dispose() {}
  }
  return { FitAddon: MockFitAddon };
});

const sessions: TerminalInfo[] = [
  {
    sessionId: "term_a",
    title: "zsh",
    cwd: "/work",
    shell: "zsh",
    pty: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    exited: false,
    projectId: null,
    scriptId: null,
  },
  {
    sessionId: "term_b",
    title: "dev",
    cwd: "/work",
    shell: "zsh",
    pty: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    exited: false,
    projectId: "p1",
    scriptId: "dev",
  },
];

const calls: { method: string; params: unknown }[] = [];
let nextOpen = 0;

function info(id: string, title: string): TerminalInfo {
  return {
    sessionId: id,
    title,
    cwd: "/work",
    shell: title,
    pty: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    exited: false,
    projectId: null,
    scriptId: null,
  };
}

beforeEach(() => {
  calls.length = 0;
  nextOpen = 0;
  useStore.setState({ status: "open" });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  }
  setBackend({
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      calls.push({ method, params });
      if (method === "terminal.list") {
        return Promise.resolve(sessions as RpcResult<M>);
      }
      if (method === "terminal.attach") {
        const sessionId = (params as RpcParams<"terminal.attach">).sessionId;
        const found =
          sessions.find((session) => session.sessionId === sessionId) ?? info(sessionId, "shell");
        return Promise.resolve(found as RpcResult<M>);
      }
      if (method === "terminal.open") {
        nextOpen += 1;
        const opened = {
          ...info(`term_new_${nextOpen}`, "bash"),
          lineEnding: "\n" as const,
        };
        return Promise.resolve(opened as RpcResult<M>);
      }
      if (
        method === "terminal.close" ||
        method === "terminal.write" ||
        method === "terminal.resize"
      ) {
        return Promise.resolve({ ok: true } as RpcResult<M>);
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  });
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderPane(ui: ReactElement = <TerminalPane />) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  return host;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.replaceChildren();
});

describe("terminalLine", () => {
  it("ends a line written to the pipe with a line feed", () => {
    expect(terminalLine("agent login")).toBe("agent login\n");
    expect(terminalLine("claude auth login")).toBe("claude auth login\n");
    expect(terminalLine("echo hello")).toBe("echo hello\n");
    expect(terminalLine("")).toBe("\n");
  });

  it("uses the line ending the server chose", () => {
    expect(terminalLine("echo hello", "\n")).toBe("echo hello\n");
    expect(terminalLine("echo hello", "\r\n")).toBe("echo hello\r\n");
    expect(terminalLine("", "\r\n")).toBe("\r\n");
  });

  it("falls back to a line feed when no ending is passed", () => {
    expect(terminalLine("agent login")).toBe("agent login\n");
  });
});

describe("TerminalPane", () => {
  it("renders with a mocked xterm and reattaches to terminal.list sessions", async () => {
    renderPane();
    await flush();
    const tabs = [...(host?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["zsh", "dev"]);
    expect(calls.some((call) => call.method === "terminal.list")).toBe(true);
    const attached = calls
      .filter((call) => call.method === "terminal.attach")
      .map((call) => call.params);
    expect(attached).toEqual([{ sessionId: "term_a" }, { sessionId: "term_b" }]);
    expect(host?.querySelector(".xterm-host")).not.toBeNull();
  });

  it("creates a tab when the new terminal button is pressed", async () => {
    renderPane();
    await flush();
    const add = host?.querySelector('[aria-label="New terminal"]');
    if (!(add instanceof HTMLButtonElement)) throw new Error("missing new terminal button");
    await act(async () => {
      add.click();
      await Promise.resolve();
    });
    const tabs = [...(host?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["zsh", "dev", "bash"]);
    expect(calls.some((call) => call.method === "terminal.open")).toBe(true);
  });

  it("writes an exit notice, dims the tab, and restarts with the same cwd and script", async () => {
    renderPane();
    await flush();
    const closesBefore = calls.filter((call) => call.method === "terminal.close").length;
    await act(async () => {
      receiveTerminal({
        push: "terminal",
        sessionId: "term_b",
        kind: "exit",
        code: 1,
        data: "\r\n[process exited with code 1]\r\n",
      });
    });
    const ended = host?.querySelector(".terminal-tab.ended");
    expect(ended).not.toBeNull();
    expect(ended?.textContent).toContain("Restart");
    expect(host?.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(calls.filter((call) => call.method === "terminal.close")).toHaveLength(closesBefore);
    const restart = host?.querySelector('[aria-label="Restart dev"]');
    if (!(restart instanceof HTMLButtonElement)) throw new Error("missing restart");
    await act(async () => {
      restart.click();
      await Promise.resolve();
    });
    const opened = calls.filter((call) => call.method === "terminal.open");
    expect(opened.at(-1)?.params).toEqual({
      cwd: "/work",
      projectId: "p1",
      scriptId: "dev",
    });
  });

  it("labels a pipe-mode tab", async () => {
    const listed = sessions[0];
    if (!listed) throw new Error("missing listed session");
    sessions[0] = { ...listed, pty: false };
    try {
      renderPane();
      await flush();
      expect(host?.textContent).toContain("pipe mode");
    } finally {
      sessions[0] = { ...listed, pty: true };
    }
  });
});
