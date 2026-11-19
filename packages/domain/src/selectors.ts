import type {
  DiffStat,
  FleetRow,
  FleetStatus,
  FleetWaitingOn,
  QueuedPrompt,
  ReadModel,
  ReviewNote,
  Thread,
  TimelineItem,
  Turn,
} from "@wooky/contracts";

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

export function queuedPrompts(model: ReadModel, threadId: string): readonly QueuedPrompt[] {
  const queue = model.threads[threadId]?.queue;
  return queue && queue.length > 0 ? queue : NONE;
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
 * Where the thread's native session should resume: the newest nativeRef among the
 * finished turns (only those before beforeTurnId, when given). Walks back over running
 * turns and turns without a ref, but stops with null at the first turn of a provider
 * other than the thread's, whose refs mean nothing to the current session.
 */
export function resumePoint(
  model: ReadModel,
  threadId: string,
  beforeTurnId?: string,
): string | null {
  const provider = model.threads[threadId]?.provider;
  const list = model.turns[threadId] ?? [];
  const end =
    beforeTurnId === undefined ? list.length : list.findIndex((t) => t.id === beforeTurnId);
  for (let index = end - 1; index >= 0; index -= 1) {
    const turn = list[index];
    if (!turn || turn.provider !== provider) return null;
    if (turn.status !== "running" && typeof turn.nativeRef === "string") return turn.nativeRef;
  }
  return null;
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

const TOOL_OUTPUT_MAX = 2_000;

function trimToolOutput(output: string, max = TOOL_OUTPUT_MAX): string {
  return output.length > max ? `${output.slice(0, max - 1)}…` : output;
}

/** Plain-text transcript used to hand a thread off to a different provider. */
export function handoffTranscript(
  model: ReadModel,
  threadId: string,
  maxChars = 24_000,
  options: { failoverToolOutput?: boolean } = {},
): string {
  const turns = model.turns[threadId] ?? [];
  const parts: string[] = [];
  for (const [index, turn] of turns.entries()) {
    const includeToolOutput =
      options.failoverToolOutput === true && index === turns.length - 1 && turn.status === "failed";
    parts.push(`User: ${turn.prompt}`);
    for (const item of turn.items) {
      if (item.kind === "message" && item.role === "assistant")
        parts.push(`Assistant: ${item.text}`);
      if (item.kind === "tool") {
        if (item.files?.length) parts.push(`(${item.title})`);
        if (includeToolOutput && item.output)
          parts.push(`Tool ${item.title}: ${trimToolOutput(item.output)}`);
      }
      if (item.kind === "plan" && item.status !== "superseded")
        parts.push(`Plan (${item.status}):\n${item.markdown}`);
    }
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** Workers spawned by this thread, oldest first. */
export function childrenOf(model: ReadModel, threadId: string): readonly Thread[] {
  const children = Object.values(model.threads)
    .filter((thread) => thread.parentThreadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return children.length > 0 ? children : NONE;
}

/** Threads in the group's `threadIds` order. Missing ids are skipped. */
export function groupThreads(model: ReadModel, groupId: string): readonly Thread[] {
  const group = model.groups[groupId];
  if (!group) return NONE;
  const threads = group.threadIds.flatMap((id) => {
    const thread = model.threads[id];
    return thread ? [thread] : [];
  });
  return threads.length > 0 ? threads : NONE;
}

/**
 * One board row per thread, newest activity first.
 * Waiting beats working. A failed last turn beats done. Only a worker or a
 * non-coordinator group member is `done` after its turn completes or is interrupted.
 * When both an approval and a question are open, `waitingOn` is `approval`.
 */
export function fleetRows(model: ReadModel): readonly FleetRow[] {
  const rows = Object.values(model.threads).map((thread) => fleetRow(model, thread));
  if (rows.length === 0) return NONE;
  rows.sort(
    (a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt) || a.threadId.localeCompare(b.threadId),
  );
  return rows;
}

function fleetRow(model: ReadModel, thread: Thread): FleetRow {
  const { status, waitingOn } = fleetStatus(model, thread);
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    provider: thread.provider,
    model: thread.model,
    role: thread.role ?? "solo",
    ...(thread.groupId ? { groupId: thread.groupId } : {}),
    ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    status,
    ...(waitingOn ? { waitingOn } : {}),
    lastActivityAt: thread.updatedAt,
    ...(thread.report?.diffStat ? { diffStat: thread.report.diffStat } : {}),
  };
}

function fleetStatus(
  model: ReadModel,
  thread: Thread,
): { status: FleetStatus; waitingOn?: FleetWaitingOn } {
  const approvals = pendingApprovals(model, thread.id);
  const questions = pendingQuestions(model, thread.id);
  if (approvals.length > 0 || questions.length > 0) {
    return { status: "waiting", waitingOn: approvals.length > 0 ? "approval" : "question" };
  }
  if (thread.status === "error") return { status: "failed" };
  if (activeTurn(model, thread.id)) return { status: "working" };
  const last = model.turns[thread.id]?.at(-1);
  if (last?.status === "failed") return { status: "failed" };
  const member =
    thread.role === "worker" || (thread.groupId !== undefined && thread.role !== "coordinator");
  if (member && (last?.status === "completed" || last?.status === "interrupted")) {
    return { status: "done" };
  }
  return { status: "idle" };
}

/** Notes for one thread, path then line then id. A missing thread yields the shared empty array. */
export function reviewNotesFor(model: ReadModel, threadId: string): readonly ReviewNote[] {
  const notes = model.reviewNotes[threadId];
  if (!notes || notes.length === 0) return NONE;
  return [...notes].sort(compareNotes);
}

function compareNotes(a: ReviewNote, b: ReviewNote): number {
  const path = a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  if (path !== 0) return path;
  if (a.line !== b.line) return a.line - b.line;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Markdown `review.send` queues or starts. Notes are emitted in the order given. */
export function formatReviewPrompt(notes: readonly ReviewNote[], extra?: string): string {
  const lines = notes.map((note) => `- \`${note.path}:${note.line}\` (${note.side}): ${note.body}`);
  const head = lines.length > 0 ? ["Review notes:", "", ...lines].join("\n") : "Review notes:";
  const tail = extra?.trim();
  return tail ? `${head}\n\n${tail}` : head;
}

/** Prompt the server queues on a coordinator when `worker.reported` is committed. */
export function formatWorkerReport(input: {
  workerThreadId: string;
  title?: string;
  turnId: string;
  summary: string;
  diffStat?: DiffStat;
}): string {
  const who = input.title ? `${input.title} (${input.workerThreadId})` : input.workerThreadId;
  const lines = [`Worker ${who} finished turn ${input.turnId}.`, "", input.summary];
  if (input.diffStat) {
    const { files, additions, deletions } = input.diffStat;
    lines.push("", `${files} files, +${additions} -${deletions}`);
  }
  return lines.join("\n");
}
