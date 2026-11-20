/**
 * @vitest-environment happy-dom
 */
import type { RpcMethod, RpcParams, RpcResult, TerminalInfo } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../../state/backend.ts";
import { useStore } from "../../state/store.ts";
import { receiveTerminal } from "../../state/terminal.ts";
import { ScriptsBar } from "./ScriptsBar.tsx";

const at = "2026-01-01T00:00:00.000Z";

const liveSession: TerminalInfo = {
  sessionId: "term_dev",
  title: "Dev",
  cwd: "/work/demo",
  shell: "zsh",
  pty: true,
  createdAt: at,
  exited: false,
  projectId: "p1",
  scriptId: "dev",
};

let listed: TerminalInfo[] = [];
const calls: { method: string; params: unknown }[] = [];
let barWidth = 800;
const widths: {
  clientWidth: PropertyDescriptor | undefined;
  offsetWidth: PropertyDescriptor | undefined;
} = { clientWidth: undefined, offsetWidth: undefined };

function seed() {
  useStore.setState({
    model: {
      ...emptyReadModel(),
      projects: {
        p1: {
          id: "p1",
          name: "demo",
          root: "/work/demo",
          createdAt: at,
          settings: {
            scripts: [
              {
                id: "dev",
                name: "Dev",
                command: "node server.js",
                runOnWorktreeCreate: false,
                previewUrl: "http://localhost:${PORT}",
              },
              {
                id: "test",
                name: "Test",
                command: "pnpm test",
                runOnWorktreeCreate: false,
              },
              {
                id: "lint",
                name: "Lint",
                command: "pnpm lint",
                runOnWorktreeCreate: false,
              },
            ],
            sharedPaths: [],
            prompts: [],
          },
        },
      },
      threads: {
        t1: {
          id: "t1",
          projectId: "p1",
          title: "Thread",
          provider: "demo",
          model: "demo",
          runtimeMode: "approve",
          worktree: null,
          providerSessionId: null,
          ownerDeviceId: null,
          movedTo: null,
          movedFrom: null,
          pullRequest: null,
          queue: [],
          status: "idle",
          createdAt: at,
          updatedAt: at,
        },
      },
    },
    selectedThreadId: "t1",
    dialog: null,
    terminalOpen: false,
  });
}

beforeEach(() => {
  listed = [];
  calls.length = 0;
  barWidth = 800;
  seed();
  setBackend({
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      calls.push({ method, params });
      if (method === "terminal.list") return Promise.resolve(listed as RpcResult<M>);
      if (method === "terminal.close") return Promise.resolve(undefined as RpcResult<M>);
      if (method === "scripts.run") {
        return Promise.resolve(liveSession as RpcResult<M>);
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  widths.clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  widths.offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return barWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 60;
    },
  });
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function render(ui: ReactElement) {
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

function button(text: string): HTMLButtonElement {
  const found = [...(host?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button ${text}`);
  return found;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  for (const name of ["clientWidth", "offsetWidth"] as const) {
    const saved = widths[name];
    if (saved) Object.defineProperty(HTMLElement.prototype, name, saved);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

describe("ScriptsBar", () => {
  it("runs a script and marks it running", async () => {
    render(<ScriptsBar />);
    await flush();
    await act(async () => {
      button("Dev").click();
      await Promise.resolve();
    });
    expect(calls.find((call) => call.method === "scripts.run")?.params).toEqual({
      projectId: "p1",
      scriptId: "dev",
      threadId: "t1",
    });
    expect(useStore.getState().terminalOpen).toBe(true);
    expect(host?.querySelector(".script-dot")).not.toBeNull();
  });

  it("stops a running script by closing its terminal session", async () => {
    listed = [liveSession];
    render(<ScriptsBar />);
    await flush();
    const stop = host?.querySelector<HTMLButtonElement>('[aria-label="Stop Dev"]');
    expect(stop).not.toBeNull();
    await act(async () => {
      stop?.click();
      await Promise.resolve();
    });
    expect(calls.find((call) => call.method === "terminal.close")?.params).toEqual({
      sessionId: "term_dev",
    });
    expect(host?.querySelector(".script-dot")).toBeNull();
    expect(host?.querySelector('[aria-label="Stop Dev"]')).toBeNull();
  });

  it("reads a live script session from terminal.list as running", async () => {
    listed = [liveSession];
    render(<ScriptsBar />);
    await flush();
    expect(host?.querySelector(".script-dot")).not.toBeNull();
    expect(calls.some((call) => call.method === "terminal.list")).toBe(true);
  });

  it("holds the preview until the port is printed, then opens it", async () => {
    listed = [liveSession];
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ScriptsBar />);
    await flush();
    const preview = button("Preview");
    expect(preview.disabled).toBe(true);
    expect(preview.getAttribute("aria-label")).toBe("Waiting for the server to print its URL");
    await act(async () => {
      receiveTerminal({
        push: "terminal",
        sessionId: "term_dev",
        kind: "data",
        data: "listening on http://localhost:5173\n",
      });
    });
    const ready = button("Preview");
    expect(ready.disabled).toBe(false);
    await act(async () => {
      ready.click();
    });
    expect(open).toHaveBeenCalledWith("http://localhost:5173", "_blank", "noopener,noreferrer");
  });

  it("moves scripts that do not fit into the overflow menu", async () => {
    barWidth = 100;
    render(<ScriptsBar />);
    await flush();
    const overflow = host?.querySelector(".script-overflow");
    if (!(overflow instanceof HTMLButtonElement)) throw new Error("missing overflow menu");
    await act(async () => {
      overflow.click();
    });
    const menu = host?.querySelector(".scripts-overflow-menu");
    expect(menu?.textContent).toContain("Lint");
    expect(host?.querySelectorAll(".scripts-bar:not(.measure) > .script-chip")).toHaveLength(1);
  });
});
