/**
 * @vitest-environment happy-dom
 */
import type { RpcMethod, RpcParams, RpcResult } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../../state/backend.ts";
import { useStore } from "../../state/store.ts";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.tsx";

const at = "2026-01-01T00:00:00.000Z";
const calls: { method: string; params: unknown }[] = [];

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
              { id: "dev", name: "Dev", command: "node server.js", runOnWorktreeCreate: false },
            ],
            sharedPaths: [],
            prompts: [],
          },
        },
      },
    },
    selectedThreadId: null,
    dialog: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  seed();
  setBackend({
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      calls.push({ method, params });
      if (method === "dispatch") {
        return Promise.resolve({ accepted: true, duplicate: false, seq: 1 } as RpcResult<M>);
      }
      if (method === "scripts.suggestSharedPaths") {
        return Promise.resolve([".env", "node_modules"] as RpcResult<M>);
      }
      return Promise.reject(new Error(`unexpected ${method}`));
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

function field(rootEl: HTMLElement, label: string): HTMLInputElement | null {
  for (const fieldEl of rootEl.querySelectorAll("label.field, label.toggle")) {
    const text = fieldEl.querySelector("span")?.textContent ?? fieldEl.textContent ?? "";
    if (text.trim().startsWith(label)) return fieldEl.querySelector("input");
  }
  return null;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
});

describe("ProjectSettingsDialog", () => {
  it("saves the edited settings through project.configure", async () => {
    render(<ProjectSettingsDialog projectId="p1" />);
    await flush();
    const name = field(host as HTMLElement, "Name");
    if (!name) throw new Error("missing name field");
    await act(async () => {
      setValue(name, "Dev server");
    });
    const save = host?.querySelector('button[type="submit"]');
    if (!(save instanceof HTMLButtonElement)) throw new Error("missing save button");
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    const dispatched = calls.find((call) => call.method === "dispatch");
    expect(dispatched?.params).toMatchObject({
      type: "project.configure",
      projectId: "p1",
      settings: {
        scripts: [{ id: "dev", name: "Dev server", command: "node server.js" }],
        sharedPaths: [],
        prompts: [],
      },
    });
    expect(useStore.getState().dialog).toBeNull();
  });

  it("collects suggested shared paths from the server", async () => {
    render(<ProjectSettingsDialog projectId="p1" />);
    await flush();
    const suggest = [...(host?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Suggest",
    );
    if (!suggest) throw new Error("missing suggest button");
    await act(async () => {
      suggest.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.some((call) => call.method === "scripts.suggestSharedPaths")).toBe(true);
    const suggestions = [...(host?.querySelectorAll(".suggestions .suggestion") ?? [])];
    expect(suggestions.map((button) => button.textContent)).toEqual([".env", "node_modules"]);
    const add = suggestions[0];
    if (!(add instanceof HTMLButtonElement)) throw new Error("missing suggestion");
    await act(async () => {
      add.click();
    });
    expect(host?.querySelectorAll(".settings-inline")).toHaveLength(1);
  });

  it("explains that nothing could be suggested when there are no gitignored entries", async () => {
    setBackend({
      call: <M extends RpcMethod>(method: M) =>
        method === "scripts.suggestSharedPaths"
          ? Promise.resolve([] as RpcResult<M>)
          : Promise.reject(new Error(`unexpected ${method}`)),
    });
    render(<ProjectSettingsDialog projectId="p1" />);
    await flush();
    const suggest = [...(host?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Suggest",
    );
    await act(async () => {
      suggest?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const hint = host?.querySelector(".suggestions .muted")?.textContent ?? "";
    expect(hint).toContain("Nothing to suggest");
    expect(hint).toContain("add a path by hand");
  });

  it("says the agent does not wait for the worktree setup command", async () => {
    render(<ProjectSettingsDialog projectId="p1" />);
    await flush();
    expect(host?.textContent).toContain("does not wait for it to finish");
    expect(field(host as HTMLElement, "Setup command")).not.toBeNull();
  });
});
