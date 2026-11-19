import type { ReviewNote, ReviewSide, ThreadStatus } from "@wooky/contracts";
import type { DiffLine } from "../../lib/diff.ts";

/** Where a note sits: one line of one file, on the old or the new side of the diff. */
export interface NoteAnchor {
  path: string;
  side: ReviewSide;
  line: number;
}

/** Added and context lines anchor to the new file, removed lines to the old one. Headers do not take notes. */
export function anchorForLine(path: string, line: DiffLine): NoteAnchor | null {
  if (line.kind === "del")
    return line.oldNo === null ? null : { path, side: "old", line: line.oldNo };
  if (line.kind === "meta" || line.newNo === null) return null;
  return { path, side: "new", line: line.newNo };
}

export function anchorKey(anchor: NoteAnchor): string {
  return JSON.stringify([anchor.path, anchor.side, anchor.line]);
}

/** Notes per anchor, in the order the selector gave them (path, then line). */
export function groupNotesByAnchor(notes: readonly ReviewNote[]): Map<string, ReviewNote[]> {
  const groups = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const key = anchorKey(note);
    const group = groups.get(key);
    if (group) group.push(note);
    else groups.set(key, [note]);
  }
  return groups;
}

export function groupNotesByPath(notes: readonly ReviewNote[]): Map<string, ReviewNote[]> {
  const groups = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const group = groups.get(note.path);
    if (group) group.push(note);
    else groups.set(note.path, [note]);
  }
  return groups;
}

export function noteLabel(note: Pick<ReviewNote, "path" | "line">): string {
  return `${note.path}:${note.line}`;
}

export function reviewBarLabel(count: number): string {
  return count === 1 ? "1 review note" : `${count} review notes`;
}

/** A turn that is running or waiting on the user takes the next prompt only after it ends. */
export function isBusy(status: ThreadStatus): boolean {
  return status === "running" || status === "waiting";
}

export function sendLabel(busy: boolean): string {
  return busy ? "Queue for agent" : "Send to agent";
}

export function sendHint(busy: boolean): string | null {
  return busy ? "The agent is busy. The notes will be queued after this turn." : null;
}

/** Why a merge cannot start right now, or null when it can. */
export function mergeBlock(input: {
  hasWorktree: boolean;
  busy: boolean;
  merging: boolean;
  conflicts: number;
}): string | null {
  if (!input.hasWorktree)
    return "This thread works in the project folder, so there is nothing to merge.";
  if (input.merging) return "A merge is already running.";
  if (input.busy) return "Wait for the running turn to finish before merging.";
  if (input.conflicts > 0) return "Resolve the conflicts first. Nothing has been merged.";
  return null;
}

export function shortSha(commit: string): string {
  return commit.slice(0, 7);
}
