/** Split panes: pure layout math, persistence and selection sync. No React, no store. */

export const PANE_MIN_PX = 320;
export const PANE_MAX = 4;
export const PANE_STORAGE_KEY = "age.panes";
export const PANE_NUDGE_PX = 16;
export const PANE_NUDGE_LARGE_PX = 64;

export interface PaneLayout {
  /** Thread per pane, left to right. */
  threadIds: string[];
  /** Share of the row per pane. Sums to 1. */
  weights: number[];
  /** Index of the pane that has focus. */
  focused: number;
}

export type ThreadIndex = Readonly<Record<string, { readonly updatedAt: string }>>;

export function singlePane(threadId: string): PaneLayout {
  return { threadIds: [threadId], weights: [1], focused: 0 };
}

export function equalWeights(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function normalizeWeights(values: readonly number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? values.map((value) => value / total) : equalWeights(values.length);
}

/**
 * Move the divider between pane `index` and `index + 1` by `deltaPx`. Both panes stop at
 * PANE_MIN_PX and the pair keeps its width. A pair too narrow for two minimums is left alone.
 */
export function resizeWeights(
  weights: readonly number[],
  index: number,
  deltaPx: number,
  availablePx: number,
): number[] {
  const share = normalizeWeights(weights);
  const left = share[index];
  const right = share[index + 1];
  if (left === undefined || right === undefined || !(availablePx > 0)) return share;
  const pairPx = (left + right) * availablePx;
  if (pairPx < 2 * PANE_MIN_PX) return share;
  const leftPx = Math.min(
    Math.max(left * availablePx + deltaPx, PANE_MIN_PX),
    pairPx - PANE_MIN_PX,
  );
  const next = [...share];
  next[index] = leftPx / availablePx;
  next[index + 1] = (pairPx - leftPx) / availablePx;
  return next;
}

export function focusPane(layout: PaneLayout, index: number): PaneLayout {
  if (index < 0 || index >= layout.threadIds.length || index === layout.focused) return layout;
  return { ...layout, focused: index };
}

export type AddPaneResult = { ok: true; layout: PaneLayout } | { ok: false };

/** Append a thread as the focused pane. A thread already shown is focused instead. */
export function addPane(layout: PaneLayout, threadId: string): AddPaneResult {
  const existing = layout.threadIds.indexOf(threadId);
  if (existing >= 0) return { ok: true, layout: focusPane(layout, existing) };
  if (layout.threadIds.length >= PANE_MAX) return { ok: false };
  const threadIds = [...layout.threadIds, threadId];
  return {
    ok: true,
    layout: { threadIds, weights: equalWeights(threadIds.length), focused: threadIds.length - 1 },
  };
}

/** Remove a thread's pane. Focus stays on the same thread, or moves right when it was the one removed. */
export function removePane(layout: PaneLayout, threadId: string): PaneLayout {
  const index = layout.threadIds.indexOf(threadId);
  if (index < 0) return layout;
  const threadIds = layout.threadIds.filter((_, i) => i !== index);
  const weights = normalizeWeights(layout.weights.filter((_, i) => i !== index));
  const shifted = index < layout.focused ? layout.focused - 1 : layout.focused;
  return { threadIds, weights, focused: Math.min(Math.max(shifted, 0), threadIds.length - 1) };
}

/** Drop panes whose thread is gone. Returns the same object when nothing was dropped. */
export function keepExisting(
  layout: PaneLayout,
  exists: (threadId: string) => boolean,
): PaneLayout {
  const kept = layout.threadIds
    .map((threadId, i) => ({ threadId, weight: layout.weights[i] ?? 0 }))
    .filter((pane) => exists(pane.threadId));
  if (kept.length === layout.threadIds.length) return layout;
  const focusedId = layout.threadIds[layout.focused];
  const focusedKept = kept.findIndex((pane) => pane.threadId === focusedId);
  const focused = focusedKept >= 0 ? focusedKept : Math.min(layout.focused, kept.length - 1);
  return {
    threadIds: kept.map((pane) => pane.threadId),
    weights: normalizeWeights(kept.map((pane) => pane.weight)),
    focused: Math.max(focused, 0),
  };
}

/** The layout as it can be shown: existing threads only, and at least two panes or null. */
export function splitLayout(
  layout: PaneLayout | null,
  exists: (threadId: string) => boolean,
): PaneLayout | null {
  if (!layout) return null;
  const kept = keepExisting(layout, exists);
  return kept.threadIds.length >= 2 ? kept : null;
}

/**
 * Store-level sync between the pane layout and the selected thread. Selection is the focused
 * pane's thread, so:
 * - a selected thread already in a pane focuses that pane;
 * - a selection from outside (sidebar, palette, history) replaces the focused pane's thread;
 * - when the selected thread was removed, the focused pane's thread becomes the selection.
 * Missing threads are pruned only once a snapshot has arrived (`pruneMissing`), so a
 * restored layout survives the empty model at boot.
 */
export function syncPanes(input: {
  panes: PaneLayout | null;
  selected: string | null;
  prevSelected: string | null;
  threads: ThreadIndex;
  pruneMissing: boolean;
}): { panes: PaneLayout | null; selected: string | null } {
  const exists = (threadId: string) => Boolean(input.threads[threadId]);
  let panes = input.panes;
  if (panes && input.pruneMissing) panes = splitLayout(panes, exists);
  if (!panes) return { panes, selected: input.selected };

  const focusedId = panes.threadIds[panes.focused] ?? null;
  if (input.selected === focusedId) return { panes, selected: input.selected };

  const selected = input.selected;
  if (selected !== null) {
    const inPanes = panes.threadIds.indexOf(selected);
    if (inPanes >= 0) return { panes: focusPane(panes, inPanes), selected };
    const prev = input.prevSelected;
    if (prev !== null && prev !== selected && exists(prev)) {
      const threadIds = panes.threadIds.map((id, i) => (i === panes.focused ? selected : id));
      return { panes: { ...panes, threadIds }, selected };
    }
  }
  return { panes, selected: focusedId };
}

/** The most recently updated thread that `accept` allows, or null. */
export function mostRecentThreadId(
  threads: ThreadIndex,
  accept: (threadId: string) => boolean,
): string | null {
  let best: { id: string; at: string } | null = null;
  for (const [id, thread] of Object.entries(threads)) {
    if (!thread || !accept(id)) continue;
    if (!best || thread.updatedAt > best.at) best = { id, at: thread.updatedAt };
  }
  return best?.id ?? null;
}

export type PaneShortcut = { kind: "split" } | { kind: "focus"; index: number };

/** ⌘\ splits with the most recent other thread; ⌘1 to ⌘4 focus a pane. */
export function paneShortcut(input: {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}): PaneShortcut | null {
  if (!input.mod || input.shift || input.alt) return null;
  if (input.key === "\\") return { kind: "split" };
  if (/^[1-4]$/.test(input.key)) return { kind: "focus", index: Number(input.key) - 1 };
  return null;
}

const MAX_ID_LENGTH = 128;
const MAX_STORED_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a stored layout. Anything malformed reads as no split. */
export function readPanes(raw: string | null): PaneLayout | null {
  if (typeof raw !== "string" || raw.length > MAX_STORED_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.threadIds)) return null;
  const threadIds: string[] = [];
  for (const id of value.threadIds) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
    if (threadIds.includes(id)) return null;
    threadIds.push(id);
  }
  if (threadIds.length < 2 || threadIds.length > PANE_MAX) return null;

  const stored = value.weights;
  const weightsOk =
    Array.isArray(stored) &&
    stored.length === threadIds.length &&
    stored.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0);
  const weights = weightsOk ? normalizeWeights(stored as number[]) : equalWeights(threadIds.length);

  const focused =
    typeof value.focused === "number" &&
    Number.isInteger(value.focused) &&
    value.focused >= 0 &&
    value.focused < threadIds.length
      ? value.focused
      : 0;
  return { threadIds, weights, focused };
}

export function writePanes(layout: PaneLayout | null): string | null {
  return layout ? JSON.stringify(layout) : null;
}

/** Per-window memory: localStorage can be missing, blocked or full. */
export function loadPanes(): PaneLayout | null {
  try {
    return readPanes(localStorage.getItem(PANE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function savePanes(layout: PaneLayout | null): void {
  try {
    const raw = writePanes(layout);
    if (raw === null) localStorage.removeItem(PANE_STORAGE_KEY);
    else localStorage.setItem(PANE_STORAGE_KEY, raw);
  } catch {
    /* ignore: the split still works for this session */
  }
}
