import type { ReviewNote } from "@age/contracts";
import { anchorKey } from "./notes.ts";

export const SNIPPET_MAX = 200;
export const PENDING_SNIPPET_LIMIT = 20;

/** A line's text as the diff shows it, whitespace collapsed and capped. Kept on the client only. */
export function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

/**
 * Whether a note's line changed since the note was written. An unknown snippet (a note made
 * before this page loaded) is never flagged. A line that is no longer in the diff is.
 */
export function isStale(snippet: string | undefined, current: string | null): boolean {
  if (snippet === undefined) return false;
  if (current === null) return true;
  return snippet !== snippetOf(current);
}

/** The snippet a composer captured for an anchor, waiting for the server to name the note. */
export interface PendingSnippet {
  threadId: string;
  key: string;
  snippet: string;
}

/**
 * Pair notes that appeared since `before` with the pending snippets their anchors were added
 * with. Each pending entry claims at most one note.
 */
export function claimSnippets(
  pending: readonly PendingSnippet[],
  before: Readonly<Record<string, readonly ReviewNote[]>>,
  after: Readonly<Record<string, readonly ReviewNote[]>>,
): { pending: PendingSnippet[]; claimed: Record<string, string> } {
  const known = new Set<string>();
  for (const notes of Object.values(before)) for (const note of notes) known.add(note.id);
  let rest = [...pending];
  const claimed: Record<string, string> = {};
  for (const notes of Object.values(after)) {
    for (const note of notes) {
      if (known.has(note.id)) continue;
      known.add(note.id);
      const key = anchorKey(note);
      const match = rest.find((entry) => entry.threadId === note.threadId && entry.key === key);
      if (!match) continue;
      claimed[note.id] = match.snippet;
      rest = rest.filter((entry) => entry !== match);
    }
  }
  return { pending: rest, claimed };
}
