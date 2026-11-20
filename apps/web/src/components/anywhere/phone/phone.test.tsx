/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureModel } from "../../../dev/fixture.ts";
import { useStore } from "../../../state/store.ts";
import { App } from "../../App.tsx";
import { installFixtureBackend, resetAnywhereHistory } from "../testing.ts";
import { PHONE_QUERY } from "./phone.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function stubViewport(phone: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PHONE_QUERY ? phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.matchMedia = globalThis.matchMedia;
}

beforeEach(() => {
  installFixtureBackend();
  resetAnywhereHistory();
  stubViewport(true);
  useStore.setState({
    model: fixtureModel,
    selectedThreadId: "t1",
    sidebarOpen: false,
    terminalOpen: false,
    settingsOpen: false,
    fleetBoardOpen: false,
    compareGroupId: null,
    newThread: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const menu = () => document.querySelector<HTMLButtonElement>('[aria-label="Show sidebar"]');

describe("phone layout", () => {
  it("starts with the composer on screen and the sidebar closed", async () => {
    await act(async () => root?.render(<App />));
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelector(".composer textarea")).not.toBeNull();
    expect(menu()).not.toBeNull();
  });

  it("opens the sidebar as a drawer and the scrim closes it", async () => {
    await act(async () => root?.render(<App />));
    await act(async () => menu()?.click());
    expect(document.querySelector(".sidebar")).not.toBeNull();
    const scrim = document.querySelector<HTMLButtonElement>(".drawer-scrim");
    expect(scrim).not.toBeNull();
    expect(document.querySelector(".composer textarea")).not.toBeNull();
    await act(async () => scrim?.click());
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.querySelector(".drawer-scrim")).toBeNull();
  });

  it("closes the drawer when a thread is chosen", async () => {
    await act(async () => root?.render(<App />));
    await act(async () => menu()?.click());
    const other = [...document.querySelectorAll<HTMLButtonElement>(".thread-button")].find(
      (entry) => entry.textContent?.includes("Fix the flaky cache test"),
    );
    await act(async () => other?.click());
    expect(useStore.getState().selectedThreadId).toBe("t2");
    expect(document.querySelector(".sidebar")).toBeNull();
  });

  it("has no scrim on a wide screen", async () => {
    stubViewport(false);
    useStore.setState({ sidebarOpen: true });
    await act(async () => root?.render(<App />));
    expect(document.querySelector(".sidebar")).not.toBeNull();
    expect(document.querySelector(".drawer-scrim")).toBeNull();
  });
});
