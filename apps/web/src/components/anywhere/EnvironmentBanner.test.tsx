/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../state/store.ts";
import { installFixtureBackend } from "./testing.ts";
import { EnvironmentBanner } from "./EnvironmentSwitcher.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<EnvironmentBanner />);
  });
}

describe("EnvironmentBanner on this machine", () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    installFixtureBackend();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it("says so when the connection to the server is lost", async () => {
    useStore.setState({ status: "reconnecting", fixture: false });
    await mount();
    expect(host?.textContent).toContain("Lost the connection");
    await act(async () => useStore.setState({ status: "offline" }));
    expect(host?.textContent).toContain("Cannot reach the Wooky server");
  });

  it("stays out of the way while connected", async () => {
    useStore.setState({ status: "open", fixture: false });
    await mount();
    expect(host?.textContent).toBe("");
  });
});
