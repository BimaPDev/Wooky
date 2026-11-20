/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureModel } from "../../../dev/fixture.ts";
import { openHistory, refreshSync, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";
import { callsTo, installFixtureBackend, resetAnywhereHistory } from "../testing.ts";
import { Toast } from "./Toast.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let backend: ReturnType<typeof installFixtureBackend>;

const settle = () => act(async () => {});
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label) as
    HTMLButtonElement | undefined;
const rowButton = (reason: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".history-row-button")].find((entry) =>
    entry.textContent?.startsWith(reason),
  );

beforeEach(async () => {
  backend = installFixtureBackend();
  resetAnywhereHistory();
  useStore.setState({ model: fixtureModel });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await refreshSync();
    root?.render(
      <>
        <HistoryPanel />
        <Toast />
      </>,
    );
  });
  await act(async () => openHistory("p1"));
  await settle();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
});

describe("project history", () => {
  it("lists snapshots with every reason, the device and the file counts", () => {
    const rows = [...document.querySelectorAll(".history-row")].map((row) => row.textContent ?? "");
    const joined = rows.join("\n");
    expect(joined).toContain("Automatic");
    expect(joined).toContain("After a turn");
    expect(joined).toContain("Saved by you");
    expect(joined).toContain("Backup");
    expect(joined).toContain("Revert");
    expect(joined).toContain("From Work Mac");
    expect(rows[1]).toContain("This device");
    expect(rows[1]).toContain("4 files");
    expect(rows[1]).toContain("Turn 1 in Paginate the orders list");
    expect(callsTo(backend.call, "sync.snapshots.list")[0]).toMatchObject({
      projectId: "p1",
      limit: 25,
    });
  });

  it("loads older snapshots with the last id as the cursor", async () => {
    await act(async () => button("Load older")?.click());
    await settle();
    const lists = callsTo(backend.call, "sync.snapshots.list");
    expect(lists.at(-1)).toMatchObject({ before: "s-25" });
    expect(document.querySelectorAll(".history-row")).toHaveLength(32);
    expect(button("Load older")).toBeUndefined();
  });

  it("compares with the current files through the diff RPC", async () => {
    const toggle = document.querySelector<HTMLInputElement>(".history-compare input");
    await act(async () => toggle?.click());
    await settle();
    expect(callsTo(backend.call, "sync.snapshots.diff").at(-1)).toMatchObject({
      against: "working",
    });
  });

  it("confirms a restore of selected files, takes the paths, and Undo restores the backup", async () => {
    await act(async () => rowButton("Saved by you")?.click());
    await settle();
    const boxes = [...document.querySelectorAll<HTMLInputElement>(".history-file input")];
    // boxes[0] is "All files"; boxes[1] is src/api/list.ts
    await act(async () => boxes[1]?.click());
    await act(async () => button("Restore selected (1)")?.click());
    expect(text()).toContain("saves a backup of the current files first");
    expect(callsTo(backend.call, "sync.snapshots.restore")).toHaveLength(0);

    await act(async () => button("Restore")?.click());
    await settle();
    const restores = callsTo(backend.call, "sync.snapshots.restore") as {
      snapshotId: string;
      paths?: string[];
    }[];
    expect(restores).toEqual([{ snapshotId: "s-05", paths: ["src/api/list.ts"] }]);
    expect(text()).toContain("Restored. Backup saved");

    await act(async () => button("Undo")?.click());
    await settle();
    const undo = (callsTo(backend.call, "sync.snapshots.restore") as { snapshotId: string }[])[1];
    expect(undo?.snapshotId).toMatch(/^backup-/);
  });

  it("restores everything without a paths list", async () => {
    await act(async () => button("Restore all")?.click());
    await act(async () => button("Restore")?.click());
    await settle();
    const [restore] = callsTo(backend.call, "sync.snapshots.restore") as Record<string, unknown>[];
    expect(restore).toEqual({ snapshotId: "s-01" });
  });

  it("shows the server's refusal while an agent is working", async () => {
    const original = window.location.search;
    window.history.replaceState(null, "", "/?fixture&restoreBusy");
    await act(async () => button("Restore all")?.click());
    await act(async () => button("Restore")?.click());
    await settle();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("An agent is working");
    expect(useAnywhereHistory.getState().toast).toBeNull();
    window.history.replaceState(null, "", `/${original}`);
  });

  it("saves a snapshot now with a label", async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Snapshot label"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "before refactor");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save snapshot now")?.click());
    await settle();
    expect(callsTo(backend.call, "sync.snapshots.create")).toEqual([
      { projectId: "p1", label: "before refactor" },
    ]);
  });
});
