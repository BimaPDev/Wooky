/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../state/store.ts";
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
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({ status: "open" });
    installFixtureBackend();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
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

  it("explains an empty workspace", async () => {
    await mountSidebar([]);
    expect(host?.textContent).toContain("No projects yet");
    expect(host?.textContent).toContain("Add a project");
  });
});
