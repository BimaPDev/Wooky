import { describe, expect, it } from "vitest";
import {
  PANE_MAX,
  PANE_MIN_PX,
  addPane,
  focusPane,
  keepExisting,
  mostRecentThreadId,
  paneShortcut,
  readPanes,
  removePane,
  resizeWeights,
  singlePane,
  splitLayout,
  syncPanes,
  writePanes,
  type PaneLayout,
} from "./layout.ts";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const at = (values: readonly number[], index: number) => values[index] ?? Number.NaN;
const layout = (threadIds: string[], focused = 0): PaneLayout => ({
  threadIds,
  weights: threadIds.map(() => 1 / threadIds.length),
  focused,
});

describe("resizeWeights", () => {
  it("moves the divider by the drag distance and keeps the pair's width", () => {
    const next = resizeWeights([0.5, 0.5], 0, 100, 1000);
    expect(at(next, 0) * 1000).toBeCloseTo(600);
    expect(at(next, 1) * 1000).toBeCloseTo(400);
    expect(sum(next)).toBeCloseTo(1);
  });

  it("clamps both panes at the minimum width", () => {
    const left = resizeWeights([0.5, 0.5], 0, -10_000, 1000);
    expect(at(left, 0) * 1000).toBeCloseTo(PANE_MIN_PX);
    const right = resizeWeights([0.5, 0.5], 0, 10_000, 1000);
    expect(at(right, 1) * 1000).toBeCloseTo(PANE_MIN_PX);
  });

  it("leaves the sizes alone when two minimums do not fit", () => {
    const weights = [0.5, 0.5];
    expect(resizeWeights(weights, 0, 200, 500)).toEqual(weights);
  });

  it("only moves the pair next to the divider", () => {
    const next = resizeWeights([0.25, 0.25, 0.5], 1, 50, 1200);
    expect(next[0]).toBeCloseTo(0.25);
    expect(at(next, 1) * 1200).toBeCloseTo(350);
    expect(at(next, 2) * 1200).toBeCloseTo(550);
  });

  it("ignores an index without a neighbour and a zero-width row", () => {
    expect(resizeWeights([0.5, 0.5], 1, 10, 1000)).toEqual([0.5, 0.5]);
    expect(resizeWeights([0.5, 0.5], 0, 10, 0)).toEqual([0.5, 0.5]);
  });
});

describe("add and remove panes", () => {
  it("appends a new pane, focuses it and resets to equal widths", () => {
    const result = addPane(singlePane("a"), "b");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.threadIds).toEqual(["a", "b"]);
    expect(result.layout.focused).toBe(1);
    expect(result.layout.weights).toEqual([0.5, 0.5]);
  });

  it("focuses a thread that is already shown instead of adding it again", () => {
    const result = addPane(layout(["a", "b", "c"], 0), "c");
    expect(result).toMatchObject({ ok: true, layout: { threadIds: ["a", "b", "c"], focused: 2 } });
  });

  it("refuses a fifth pane", () => {
    const full = layout(["a", "b", "c", "d"]);
    expect(PANE_MAX).toBe(4);
    expect(addPane(full, "e")).toEqual({ ok: false });
  });

  it("keeps focus on the same thread when another pane closes", () => {
    const before = layout(["a", "b", "c"], 2);
    const after = removePane(before, "a");
    expect(after.threadIds).toEqual(["b", "c"]);
    expect(after.threadIds[after.focused]).toBe("c");
    expect(sum(after.weights)).toBeCloseTo(1);
  });

  it("moves focus to the pane that takes the closed slot", () => {
    const after = removePane(layout(["a", "b", "c"], 1), "b");
    expect(after.threadIds).toEqual(["a", "c"]);
    expect(after.threadIds[after.focused]).toBe("c");
  });

  it("drops to a single pane, which is no split", () => {
    expect(splitLayout(removePane(layout(["a", "b"]), "b"), () => true)).toBeNull();
  });

  it("focusPane ignores out-of-range indices", () => {
    const base = layout(["a", "b"]);
    expect(focusPane(base, 5)).toBe(base);
    expect(focusPane(base, 1).focused).toBe(1);
  });
});

describe("existence", () => {
  it("prunes missing threads and keeps focus on the same thread", () => {
    const pruned = keepExisting(layout(["a", "b", "c"], 2), (id) => id !== "a");
    expect(pruned.threadIds).toEqual(["b", "c"]);
    expect(pruned.threadIds[pruned.focused]).toBe("c");
  });

  it("returns the same object when nothing is missing", () => {
    const base = layout(["a", "b"]);
    expect(keepExisting(base, () => true)).toBe(base);
  });

  it("reads as no split when fewer than two panes survive", () => {
    expect(splitLayout(layout(["a", "b"]), (id) => id === "a")).toBeNull();
    expect(splitLayout(null, () => true)).toBeNull();
  });
});

describe("syncPanes", () => {
  const threads = { a: { updatedAt: "1" }, b: { updatedAt: "2" }, c: { updatedAt: "3" } };
  const base = layout(["a", "b"], 0);

  it("focuses the pane when the selection is already shown", () => {
    const next = syncPanes({
      panes: base,
      selected: "b",
      prevSelected: "a",
      threads,
      pruneMissing: true,
    });
    expect(next.panes?.focused).toBe(1);
    expect(next.selected).toBe("b");
  });

  it("replaces the focused pane when the user navigates to another thread", () => {
    const next = syncPanes({
      panes: base,
      selected: "c",
      prevSelected: "a",
      threads,
      pruneMissing: true,
    });
    expect(next.panes?.threadIds).toEqual(["c", "b"]);
    expect(next.panes?.focused).toBe(0);
    expect(next.selected).toBe("c");
  });

  it("moves the selection to the focused pane when the selected thread was removed", () => {
    const next = syncPanes({
      panes: layout(["a", "b"], 1),
      selected: "c",
      prevSelected: "c",
      threads: { a: threads.a, b: threads.b },
      pruneMissing: true,
    });
    expect(next.panes?.threadIds).toEqual(["a", "b"]);
    expect(next.selected).toBe("b");
  });

  it("prunes a removed pane and keeps the selected thread's pane focused", () => {
    const kept = syncPanes({
      panes: layout(["a", "b", "c"], 2),
      selected: "a",
      prevSelected: "c",
      threads: { a: threads.a, b: threads.b },
      pruneMissing: true,
    });
    expect(kept.panes?.threadIds).toEqual(["a", "b"]);
    expect(kept.panes?.focused).toBe(0);
    expect(kept.selected).toBe("a");
  });

  it("drops the split when fewer than two of its threads remain", () => {
    const next = syncPanes({
      panes: layout(["a", "b"], 1),
      selected: "b",
      prevSelected: "b",
      threads: { a: threads.a },
      pruneMissing: true,
    });
    expect(next).toEqual({ panes: null, selected: "b" });
  });

  it("keeps a restored layout while the snapshot has not arrived", () => {
    const next = syncPanes({
      panes: base,
      selected: null,
      prevSelected: null,
      threads: {},
      pruneMissing: false,
    });
    expect(next.panes).toBe(base);
    expect(next.selected).toBe("a");
  });

  it("is stable once the selection matches the focused pane", () => {
    const first = syncPanes({
      panes: base,
      selected: "a",
      prevSelected: "a",
      threads,
      pruneMissing: true,
    });
    expect(first.panes).toBe(base);
    expect(first.selected).toBe("a");
  });
});

describe("persistence", () => {
  it("round-trips a layout", () => {
    const saved = layout(["a", "b", "c"], 1);
    expect(readPanes(writePanes(saved))).toEqual(saved);
  });

  it("reads missing storage as no split", () => {
    expect(readPanes(null)).toBeNull();
    expect(writePanes(null)).toBeNull();
  });

  it("treats garbage as no split", () => {
    const garbage = [
      "",
      "{",
      "null",
      "42",
      '"two"',
      "[]",
      "{}",
      '{"threadIds":"ab"}',
      '{"threadIds":["a"]}',
      '{"threadIds":["a","a"]}',
      '{"threadIds":["a",1]}',
      '{"threadIds":["a",""]}',
      `{"threadIds":["a","${"x".repeat(200)}"]}`,
      '{"threadIds":["a","b","c","d","e"]}',
      "x".repeat(10_000),
    ];
    for (const raw of garbage) expect(readPanes(raw)).toBeNull();
  });

  it("repairs bad weights and focus without dropping the layout", () => {
    const repaired = readPanes(
      JSON.stringify({ threadIds: ["a", "b"], weights: [-1, "x"], focused: 9 }),
    );
    expect(repaired).toEqual({ threadIds: ["a", "b"], weights: [0.5, 0.5], focused: 0 });

    const normalized = readPanes(
      JSON.stringify({ threadIds: ["a", "b"], weights: [3, 1], focused: 1 }),
    );
    expect(normalized?.weights[0]).toBeCloseTo(0.75);
    expect(normalized?.focused).toBe(1);

    const fractional = readPanes(JSON.stringify({ threadIds: ["a", "b"], focused: 0.5 }));
    expect(fractional?.focused).toBe(0);
  });
});

describe("shortcuts and recent threads", () => {
  it("maps ⌘\\ and ⌘1–4 and nothing else", () => {
    expect(paneShortcut({ key: "\\", mod: true, shift: false, alt: false })).toEqual({
      kind: "split",
    });
    expect(paneShortcut({ key: "3", mod: true, shift: false, alt: false })).toEqual({
      kind: "focus",
      index: 2,
    });
    expect(paneShortcut({ key: "5", mod: true, shift: false, alt: false })).toBeNull();
    expect(paneShortcut({ key: "1", mod: false, shift: false, alt: false })).toBeNull();
    expect(paneShortcut({ key: "1", mod: true, shift: true, alt: false })).toBeNull();
  });

  it("picks the most recently updated thread that is accepted", () => {
    const threads = {
      a: { updatedAt: "2026-01-01T10:00:00Z" },
      b: { updatedAt: "2026-01-02T10:00:00Z" },
      c: { updatedAt: "2026-01-03T10:00:00Z" },
    };
    expect(mostRecentThreadId(threads, () => true)).toBe("c");
    expect(mostRecentThreadId(threads, (id) => id !== "c")).toBe("b");
    expect(mostRecentThreadId({}, () => true)).toBeNull();
  });
});
