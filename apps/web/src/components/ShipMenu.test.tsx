/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcResult } from "@wooky/contracts";
import { useStore } from "../state/store.ts";
import { ShipMenu } from "./ShipMenu.tsx";

const loadGitStatus = vi.fn<(threadId: string) => Promise<RpcResult<"git.status">>>();
const loadPrStatus = vi.fn<(threadId: string) => Promise<null>>(() => Promise.resolve(null));

vi.mock("../state/actions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/actions.ts")>();
  return {
    ...actual,
    loadGitStatus: (...args: Parameters<typeof loadGitStatus>) => loadGitStatus(...args),
    loadPrStatus: (...args: Parameters<typeof loadPrStatus>) => loadPrStatus(...args),
    commitGit: vi.fn<() => Promise<{ sha: string }>>(),
    pushGit: vi.fn<() => Promise<{ ok: true; remoteUrl: string }>>(),
    createPullRequest: vi.fn<() => Promise<{ url: string; number: number }>>(),
  };
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const readyStatus: RpcResult<"git.status"> = {
  branch: "feature",
  upstream: "origin/feature",
  ahead: 2,
  behind: 0,
  dirty: true,
  hasRemote: true,
  ghAvailable: true,
  ghAuthed: true,
};

beforeEach(() => {
  useStore.setState({
    diffVersion: 0,
    model: {
      ...useStore.getState().model,
      threads: {
        "t-ship": {
          id: "t-ship",
          projectId: "p1",
          title: "Ship fixture",
          provider: "demo",
          model: "demo",
          runtimeMode: "full",
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          worktree: null,
          providerSessionId: null,
          ownerDeviceId: null,
          movedTo: null,
          movedFrom: null,
          pullRequest: null,
          queue: [],
        },
      },
    },
  });
  loadGitStatus.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function renderMenu() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ShipMenu threadId="t-ship" />);
  });
}

function button(label: string) {
  return [...(host?.querySelectorAll("button") ?? [])].find(
    (element) => element.textContent?.trim() === label,
  );
}

describe("ShipMenu", () => {
  it("enables commit and push when git is ready", async () => {
    loadGitStatus.mockResolvedValue(readyStatus);
    renderMenu();
    await vi.waitFor(() => {
      expect(button("Commit")?.disabled).toBe(false);
      expect(button("Push (2)")?.disabled).toBe(false);
      expect(button("Create PR")?.disabled).toBe(false);
    });
  });

  it("disables create PR when gh is missing", async () => {
    loadGitStatus.mockResolvedValue({
      ...readyStatus,
      ghAvailable: false,
      ghAuthed: false,
    });
    renderMenu();
    await vi.waitFor(() => {
      const create = button("Create PR");
      expect(create?.disabled).toBe(true);
      expect(create?.getAttribute("aria-describedby")).toBeTruthy();
      expect(host?.querySelector(".ship-hint")?.textContent).toBe("gh not installed");
    });
  });

  it("shows a linked pull request pill", async () => {
    const base = useStore.getState().model.threads["t-ship"];
    if (!base) throw new Error("missing thread");
    useStore.setState((state) => ({
      model: {
        ...state.model,
        threads: {
          ...state.model.threads,
          "t-ship": {
            ...base,
            pullRequest: {
              url: "https://github.com/example/repo/pull/12",
              number: 12,
              state: "open",
              branch: "feature",
            },
          },
        },
      },
    }));
    loadGitStatus.mockResolvedValue(readyStatus);
    renderMenu();
    await vi.waitFor(() => {
      const pill = host?.querySelector(".ship-pr-pill");
      expect(pill?.textContent).toBe("#12 open");
      expect(pill?.getAttribute("href")).toBe("https://github.com/example/repo/pull/12");
    });
  });
});
