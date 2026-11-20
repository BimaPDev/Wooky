/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureModel } from "../../../dev/fixture.ts";
import { refreshSync, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";
import { App } from "../../App.tsx";
import { installFixtureBackend, resetAnywhereHistory } from "../testing.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(async () => {
  installFixtureBackend();
  resetAnywhereHistory();
  useStore.setState({
    model: { ...fixtureModel, pendingClaims: {} },
    selectedThreadId: "t1",
    sidebarOpen: true,
    settingsOpen: false,
  });
  await refreshSync();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
});

describe("peer threads", () => {
  it("lists each peer under its name and opens a thread read-only, without a composer", async () => {
    await act(async () => root?.render(<App />));
    const sections = [...document.querySelectorAll(".sidebar-replicas")].map((section) =>
      section.getAttribute("aria-label"),
    );
    expect(sections).toEqual(["On Windows PC", "On Work Mac"]);

    const row = [
      ...document.querySelectorAll<HTMLButtonElement>(".sidebar-replicas .thread-button"),
    ].find((entry) => entry.textContent?.includes("Retry failed uploads"));
    await act(async () => row?.click());
    expect(useAnywhereHistory.getState().replicaView).toEqual({
      deviceId: "dev-work",
      threadId: "w-upload",
    });
    expect(document.body.textContent).toContain("This thread runs on Work Mac");
    expect(document.body.textContent).toContain("Uploads now retry up to");
    expect(document.querySelector(".composer")).toBeNull();
    expect(document.body.textContent).not.toContain("Revert to before this turn");

    await act(async () => useStore.setState({ selectedThreadId: "t2" }));
    expect(useAnywhereHistory.getState().replicaView).toBeNull();
  });

  it("shows a banner on a moved thread and turns its composer off", async () => {
    useStore.setState({ selectedThreadId: "t-moved" });
    await act(async () => root?.render(<App />));
    expect(document.body.textContent).toContain("Moved to Work Mac");
    expect(document.querySelector("fieldset.composer-locked")?.hasAttribute("disabled")).toBe(true);
  });

  it("marks a thread that was continued from another device", async () => {
    useStore.setState({ selectedThreadId: "t-continued" });
    await act(async () => root?.render(<App />));
    expect(document.querySelector(".continued-from")?.textContent).toBe("Continued from Work Mac");
  });
});
