import type { Turn } from "@wooky/contracts";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface TurnSummary {
  durationMs: number;
  steps: number;
  changedFiles: string[];
  text: string;
}

/** The one-line summary a finished turn collapses into. */
export function summarizeTurn(
  turn: Pick<
    Turn,
    "startedAt" | "endedAt" | "items" | "changedFiles" | "waitedMs" | "waitingSince"
  >,
  now = Date.now(),
): TurnSummary {
  const start = Date.parse(turn.startedAt);
  const end = turn.endedAt ? Date.parse(turn.endedAt) : now;
  // Time spent waiting on an approval or a question is the user's, not the agent's.
  const since = turn.waitingSince ? Date.parse(turn.waitingSince) : NaN;
  const waiting = (turn.waitedMs ?? 0) + (Number.isFinite(since) ? Math.max(0, end - since) : 0);
  const durationMs =
    Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start - waiting) : 0;
  const steps = turn.items.filter((item) => item.kind === "tool").length;
  const changedFiles = [...new Set(turn.changedFiles)];
  const parts = [`Worked for ${formatDuration(durationMs)}`];
  if (steps > 0) parts.push(plural(steps, "step"));
  if (changedFiles.length > 0) parts.push(`${plural(changedFiles.length, "file")} changed`);
  return { durationMs, steps, changedFiles, text: parts.join(" · ") };
}
