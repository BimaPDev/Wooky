/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../state/store.ts";
import { installFixtureBackend, resetAnywhereHistory } from "./anywhere/testing.ts";
import { App } from "./App.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let errors: ReturnType<typeof vi.spyOn>;

// A selector that returns a fresh array/object each call makes zustand re-render forever:
// React throws error #185 ("Maximum update depth exceeded") or warns about getSnapshot.
async function mountApp() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
}

describe("App on a fresh install (no projects, no threads)", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({ status: "connected" });
    resetAnywhereHistory();
    installFixtureBackend();
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    errors.mockRestore();
    document.body.innerHTML = "";
  });

  it("renders the empty state without looping or logging errors", async () => {
    await mountApp();
    expect(document.body.textContent?.length).toBeGreaterThan(0);
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([]);
  });

  it("opens the new-thread view and its composer menu on an empty store", async () => {
    await mountApp();
    await act(async () => {
      useStore.setState({ newThread: { projectId: null } as never });
    });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([]);
  });

  it("renders Settings -> Anywhere on an empty store", async () => {
    await mountApp();
    await act(async () => {
      useStore.setState({ settingsOpen: true, settingsPage: "anywhere" });
    });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([]);
    expect(document.body.textContent).toContain("Anywhere");
  });
});
