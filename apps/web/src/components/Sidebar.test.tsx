/**
 * @vitest-environment happy-dom
 */
import { emptyReadModel } from "@wooky/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveSnapshot, useStore } from "../state/store.ts";
import { installFixtureBackend } from "./anywhere/testing.ts";
import { Sidebar } from "./Sidebar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const project = (id: string, name: string, scratch?: boolean) => ({
  id,
  name,
  root: `/work/${name}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(scratch ? { scratch } : {}),
  settings: {},
});

async function mountSidebar(projects: ReturnType<typeof project>[]) {
  const initial = useStore.getState().model;
  useStore.setState({
    model: {
      ...initial,
      projects: Object.fromEntries(projects.map((entry) => [entry.id, entry])),
    } as never,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Sidebar />);
  });
}

describe("Sidebar project list", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({ status: "open", hasSnapshot: true });
    installFixtureBackend();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    vi.useRealTimers();
    host?.remove();
    root = undefined;
    host = undefined;
    document.body.innerHTML = "";
  });

  it("lists a project that has no threads, with a new-thread action", async () => {
    await mountSidebar([project("p1", "demo")]);
    expect(host?.querySelector(".project-name")?.textContent).toBe("demo");
    expect(host?.querySelector('[aria-label="New thread in demo"]')).not.toBeNull();
    expect(host?.textContent).not.toContain("No projects yet");
  });

  it("hides the scratch folder until it has threads", async () => {
    await mountSidebar([project("s1", "No project", true)]);
    expect(host?.querySelector(".project-name")).toBeNull();
  });

  it("waits through the grace delay before showing Connecting and never flashes No projects yet", async () => {
    useStore.setState({ status: "connecting", hasSnapshot: false });
    await mountSidebar([]);
    expect(host?.textContent).not.toContain("Connecting to Wooky");
    expect(host?.textContent).not.toContain("No projects yet");

    // Socket opens before the initial snapshot arrives: still quiet during the grace window.
    await act(async () => {
      useStore.setState({ status: "open" });
    });
    expect(host?.textContent).not.toContain("No projects yet");
    expect(host?.textContent).not.toContain("Connecting to Wooky");

    // Past the grace window without a snapshot: shows Connecting, not No projects yet.
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(host?.textContent).toContain("Connecting to Wooky");
    expect(host?.textContent).not.toContain("No projects yet");

    // Snapshot arrives empty: now explains the empty workspace.
    await act(async () => {
      receiveSnapshot(emptyReadModel());
    });
    expect(host?.textContent).toContain("No projects yet");
    expect(host?.textContent).not.toContain("Connecting to Wooky");
  });

  it("never flashes Connecting on a fast connect + snapshot", async () => {
    useStore.setState({ status: "connecting", hasSnapshot: false });
    await mountSidebar([]);
    await act(async () => {
      vi.advanceTimersByTime(100);
      useStore.setState({ status: "open" });
      receiveSnapshot({
        ...emptyReadModel(),
        projects: { p1: project("p1", "demo") as never },
      });
    });
    expect(host?.textContent).not.toContain("Connecting to Wooky");
    expect(host?.textContent).not.toContain("No projects yet");
    expect(host?.querySelector(".project-name")?.textContent).toBe("demo");
  });

  it("shows offline and reconnecting immediately when there are no projects", async () => {
    useStore.setState({ status: "offline", hasSnapshot: false });
    await mountSidebar([]);
    expect(host?.textContent).toContain("Wooky is not reachable");
    expect(host?.textContent).not.toContain("No projects yet");

    await act(async () => {
      useStore.setState({ status: "reconnecting" });
    });
    expect(host?.textContent).toContain("Reconnecting");
  });

  it("explains an empty workspace once a snapshot has arrived", async () => {
    useStore.setState({ status: "open", hasSnapshot: true });
    await mountSidebar([]);
    expect(host?.textContent).toContain("No projects yet");
    expect(host?.textContent).toContain("Add a project");
  });
});
