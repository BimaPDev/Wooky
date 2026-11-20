/**
 * @vitest-environment happy-dom
 */
import type { Thread } from "@wooky/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureModel } from "../../../dev/fixture.ts";
import { fixtureReplicas } from "../../../dev/fixture-anywhere-history.ts";
import { refreshSync, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";
import { callsTo, installFixtureBackend, resetAnywhereHistory } from "../testing.ts";
import { ClaimBanner } from "./ClaimBanner.tsx";
import { claimView, isBusyReason, resolveLocalProject } from "./helpers.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORK = "dev-work";
const owner = fixtureReplicas.replicas[WORK]?.threads["w-billing"] as Thread;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label) as
    HTMLButtonElement | undefined;

function renderBanner() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<ClaimBanner deviceId={WORK} thread={owner} device="Work Mac" />));
}

beforeEach(async () => {
  installFixtureBackend();
  resetAnywhereHistory();
  useStore.setState({
    model: { ...fixtureModel, pendingClaims: {} },
    dialog: null,
    selectedThreadId: null,
    deviceSettings: {
      ...(useStore.getState().deviceSettings as object),
      sync: { enabled: true, projectMap: { p1: { "dev-home": "/Users/demo/code/orders-api" } } },
    } as never,
  });
  await refreshSync();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
});

describe("claim banner", () => {
  it("offers to continue and dispatches thread.claim with the mapped local project", async () => {
    const backend = installFixtureBackend();
    renderBanner();
    expect(document.body.textContent).toContain("This thread runs on Work Mac");
    await act(async () => button("Continue on this device")?.click());
    const [dispatched] = callsTo(backend.call, "dispatch") as Record<string, unknown>[];
    expect(dispatched).toMatchObject({
      type: "thread.claim",
      ownerDeviceId: WORK,
      ownerThreadId: "w-billing",
      projectId: "p1",
      force: false,
    });
  });

  it("is disabled, with a reason, when the project is not mapped to a local folder", () => {
    useStore.setState({ model: { ...fixtureModel, pendingClaims: {}, projects: {} } });
    renderBanner();
    expect(button("Continue on this device")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("not mapped on this device");
    expect(button("Add this project…")).toBeDefined();
  });

  it("offers the suggested local project in one click and maps it under the peer's project id", async () => {
    const backend = installFixtureBackend();
    useStore.setState({
      deviceSettings: {
        ...(useStore.getState().deviceSettings as object),
        sync: { enabled: true, projectMap: {} },
      } as never,
    });
    const peers = useAnywhereHistory.getState().syncStatus?.peers ?? [];
    useAnywhereHistory.setState({
      syncStatus: {
        enabled: true,
        conflicts: [],
        peers: peers.map((peer) => ({
          ...peer,
          projects: [
            {
              id: "p1",
              sharedId: "shared-orders",
              name: "orders-api (work)",
              folder: "orders-api",
              remote: "github.com/demo/orders-api",
              branch: "main",
              mappedTo: null,
              suggestion: { projectId: "p2", by: "remote" },
            },
          ],
        })),
      },
    });
    renderBanner();
    expect(document.body.textContent).toContain("orders-api (work) is not mapped on this device");
    expect(button("Continue on this device")?.disabled).toBe(true);
    const local = fixtureModel.projects.p2?.name;
    await act(async () => button(`Use ${local}`)?.click());
    expect(callsTo(backend.call, "sync.projects.map")).toEqual([
      { sharedId: "shared-orders", localProjectId: "p2" },
    ]);
  });

  it("shows the pending state while the claim is in the read model", () => {
    useStore.setState({
      model: {
        ...fixtureModel,
        pendingClaims: {
          c1: {
            claimId: "c1",
            ownerDeviceId: WORK,
            ownerThreadId: "w-billing",
            projectId: "p1",
            at: new Date().toISOString(),
          },
        },
      },
    });
    renderBanner();
    expect(document.body.textContent).toContain("Moving… syncing files, then the conversation");
    expect(button("Moving…")?.disabled).toBe(true);
    expect(button("Continue on this device")).toBeUndefined();
  });

  it("offers Force move only after a busy failure, and confirms the stop first", async () => {
    useAnywhereHistory.setState({
      claimFailures: {
        [`${WORK}:w-billing`]: "The agent on Work Mac is busy with a running turn.",
      },
    });
    renderBanner();
    expect(document.body.textContent).toContain("Force move stops the running turn");
    const backend = installFixtureBackend();
    await act(async () => button("Force move")?.click());
    expect(callsTo(backend.call, "dispatch")).toHaveLength(0);
    const dialog = useStore.getState().dialog;
    expect(dialog?.kind).toBe("confirm");
    if (dialog?.kind !== "confirm") return;
    expect(dialog.body).toContain("stops its running turn");
    await act(async () => dialog.onConfirm());
    const [forced] = callsTo(backend.call, "dispatch") as Record<string, unknown>[];
    expect(forced).toMatchObject({ type: "thread.claim", force: true });
  });

  it("offers no Force move for a failure that is not about a busy agent", () => {
    useAnywhereHistory.setState({
      claimFailures: { [`${WORK}:w-billing`]: "Files have not finished syncing." },
    });
    renderBanner();
    expect(button("Force move")).toBeUndefined();
    expect(button("Try again")).toBeDefined();
  });

  it("opens the new local thread when the claim lands", async () => {
    renderBanner();
    await act(async () => button("Continue on this device")?.click());
    const imported: Thread = {
      ...owner,
      id: "t-claimed",
      ownerDeviceId: null,
      movedFrom: { deviceId: WORK, threadId: "w-billing" },
    };
    await act(async () =>
      useStore.setState({
        model: { ...fixtureModel, threads: { ...fixtureModel.threads, [imported.id]: imported } },
      }),
    );
    expect(useStore.getState().selectedThreadId).toBe("t-claimed");
  });
});

describe("claim helpers", () => {
  it("reads a busy refusal", () => {
    expect(isBusyReason("The agent on Work Mac is busy")).toBe(true);
    expect(isBusyReason("A turn is running")).toBe(true);
    // The server's own wording when the owner has a turn in flight (transfer/claim.ts).
    expect(isBusyReason("The owner is still working on that thread.")).toBe(true);
    expect(isBusyReason("A turn is already running on this thread.")).toBe(true);
    expect(isBusyReason("worker is running out of disk")).toBe(false);
    expect(isBusyReason("Network error")).toBe(false);
  });

  it("orders done, pending, failed, ready", () => {
    const base = { ownerDeviceId: WORK, ownerThreadId: "x" };
    const model = { threads: {}, pendingClaims: {} };
    expect(claimView({ ...base, model, failure: undefined }).kind).toBe("ready");
    expect(claimView({ ...base, model, failure: "busy" })).toMatchObject({
      kind: "failed",
      canForce: true,
    });
  });

  it("maps the peer's project through settings.sync.projectMap", () => {
    const projects = fixtureModel.projects;
    expect(
      resolveLocalProject(
        "elsewhere",
        projects,
        { elsewhere: { me: "/Users/demo/code/site/" } },
        "me",
      )?.id,
    ).toBe("p2");
    expect(resolveLocalProject("p1", projects, {}, "me")?.id).toBe("p1");
    expect(resolveLocalProject("nope", projects, {}, "me")).toBeNull();
  });
});
