/**
 * @vitest-environment happy-dom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshSync, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { callsTo, installFixtureBackend, resetAnywhereHistory } from "../testing.ts";
import { ConflictCard } from "./ConflictCard.tsx";
import { conflictSides, theirsPath } from "./helpers.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let backend: ReturnType<typeof installFixtureBackend>;

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label) as
    HTMLButtonElement | undefined;

beforeEach(async () => {
  backend = installFixtureBackend();
  resetAnywhereHistory();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await refreshSync();
    const conflict = useAnywhereHistory.getState().syncStatus?.conflicts[0];
    if (conflict) root?.render(<ConflictCard conflict={conflict} />);
  });
  await act(async () => {});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("conflict card", () => {
  it("names the peer, lists the paths and shows both sides", () => {
    expect(document.body.textContent).toContain("Sync conflict with Work Mac");
    expect(document.body.textContent).toContain("src/api/list.ts");
    expect(document.body.textContent).toContain("README.md");
    expect(document.body.textContent).toContain("Mine");
    expect(document.body.textContent).toContain("Theirs, Work Mac");
    const diffs = callsTo(backend.call, "sync.snapshots.diff");
    expect(diffs).toEqual([
      { snapshotId: "s-01", against: "s-05" },
      { snapshotId: "peer-work-1", against: "s-05" },
    ]);
  });

  it("explains Keep both with the .theirs name", () => {
    expect(document.body.textContent).toContain("saved as src/api/list.theirs.ts");
  });

  it.each([
    ["Keep mine", "mine"],
    ["Take theirs", "theirs"],
    ["Keep both", "both"],
  ])("%s resolves the conflict as %s", async (label, resolution) => {
    await act(async () => button(label)?.click());
    expect(callsTo(backend.call, "sync.conflicts.resolve")).toEqual([
      { conflictId: "conflict-1", resolution },
    ]);
  });
});

describe("conflict helpers", () => {
  it("names the peer's copy", () => {
    expect(theirsPath("src/a/list.ts")).toBe("src/a/list.theirs.ts");
    expect(theirsPath("Makefile")).toBe("Makefile.theirs");
    expect(theirsPath(".env")).toBe(".env.theirs");
  });

  it("compares the sides with each other when there is no common ancestor", () => {
    const sides = conflictSides({
      id: "c",
      projectId: "p",
      peerDeviceId: "d",
      mine: "m",
      theirs: "t",
      base: null,
      paths: [],
      createdAt: "",
    });
    expect(sides.mine).toMatchObject({ snapshotId: "m", against: "t" });
    expect(sides.theirs).toMatchObject({ snapshotId: "t", against: "m" });
  });
});
