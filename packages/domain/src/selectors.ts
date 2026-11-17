import type { QueuedPrompt, ReadModel, Thread, TimelineItem, Turn } from "@age/contracts";

type ItemOf<K extends TimelineItem["kind"]> = Extract<TimelineItem, { kind: K }>;

/** Shared empty result, so clients selecting by reference do not re-render on every event. */
const NONE: readonly never[] = Object.freeze([]);

export function threadsForProject(model: ReadModel, projectId: string): Thread[] {
  return Object.values(model.threads)
    .filter((thread) => thread.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function activeTurn(model: ReadModel, threadId: string): Turn | null {
  const last = model.turns[threadId]?.at(-1);
  return last?.status === "running" ? last : null;
}

export function pendingApprovals(model: ReadModel, threadId: string) {
  const turn = activeTurn(model, threadId);
  if (!turn) return [];
  return turn.items.filter((item) => item.kind === "approval" && item.decision === null);
}

export function pendingQuestions(
  model: ReadModel,
  threadId: string,
): readonly ItemOf<"question">[] {
  const turn = activeTurn(model, threadId);
  if (!turn) return NONE;
  const open = turn.items.filter(
    (item): item is ItemOf<"question"> =>
      item.kind === "question" && item.answers === null && !item.dismissed,
  );
  return open.length > 0 ? open : NONE;
}

export function queuedPrompts(model: ReadModel, threadId: string): QueuedPrompt[] {
  return model.threads[threadId]?.queue ?? [];
}

export function nextQueued(model: ReadModel, threadId: string): QueuedPrompt | null {
  return queuedPrompts(model, threadId)[0] ?? null;
}

/** The newest plan item in the thread, whatever its status. */
export function latestPlan(model: ReadModel, threadId: string): ItemOf<"plan"> | null {
  for (const turn of (model.turns[threadId] ?? []).toReversed()) {
    const plan = turn.items.findLast((item): item is ItemOf<"plan"> => item.kind === "plan");
    if (plan) return plan;
  }
  return null;
}

/**
 * Where the native session should resume: the newest nativeRef among the finished turns
 * still in the thread (after a revert, the kept ones). Turns that recorded none are
 * skipped. Null only when no finished turn has one.
 */
export function resumePoint(model: ReadModel, threadId: string): string | null {
  const kept = model.turns[threadId]?.findLast(
    (turn) => turn.status !== "running" && typeof turn.nativeRef === "string",
  );
  return kept?.nativeRef ?? null;
}

/**
 * Other threads working in the same checkout: neither side has (or will get) its own
 * worktree, and both belong to projects with the same root.
 */
export function threadsSharingWorkspace(model: ReadModel, threadId: string): readonly Thread[] {
  const thread = model.threads[threadId];
  if (!thread || !sharesRoot(thread)) return NONE;
  const root = model.projects[thread.projectId]?.root;
  if (root === undefined) return NONE;
  const sharing = Object.values(model.threads).filter(
    (other) =>
      other.id !== thread.id && sharesRoot(other) && model.projects[other.projectId]?.root === root,
  );
  return sharing.length > 0 ? sharing : NONE;
}

function sharesRoot(thread: Thread): boolean {
  return thread.worktree === null && !thread.isolate;
}

/** Plain-text transcript used to hand a thread off to a different provider. */
export function handoffTranscript(model: ReadModel, threadId: string, maxChars = 24_000): string {
  const parts: string[] = [];
  for (const turn of model.turns[threadId] ?? []) {
    parts.push(`User: ${turn.prompt}`);
    for (const item of turn.items) {
      if (item.kind === "message" && item.role === "assistant")
        parts.push(`Assistant: ${item.text}`);
      if (item.kind === "tool" && item.files?.length) parts.push(`(${item.title})`);
      if (item.kind === "plan" && item.status !== "superseded")
        parts.push(`Plan (${item.status}):\n${item.markdown}`);
    }
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
