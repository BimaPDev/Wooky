import type { CommandOf, PendingEvent, ReadModel, Thread, ThreadGroup } from "@age/contracts";
import { FLEET_LIMITS } from "@age/contracts";
import { childrenOf, fleetRows, formatReviewPrompt, reviewNotesFor } from "@age/domain";
import { checkpointRef, type Effect } from "./effects.ts";
import type { DecideContext } from "./decide.ts";

const DEFAULT_TITLE = "New thread";
const TITLE_MAX = 60;

type Draft = PendingEvent extends infer E
  ? E extends unknown
    ? Omit<E, "commandId">
    : never
  : never;

export type PartialDecision =
  | { ok: true; events: Draft[]; effects: Effect[] }
  | { ok: false; code: "bad_request" | "not_found" | "conflict"; message: string };

export function decideThreadSpawn(
  model: ReadModel,
  command: CommandOf<"thread.spawn">,
  ctx: DecideContext,
): PartialDecision {
  const parent = model.threads[command.parentThreadId];
  if (!parent) return notFound("thread", command.parentThreadId);
  if (parent.role === "worker" || parent.parentThreadId)
    return reject("bad_request", "Only a solo thread or coordinator can spawn workers.");
  if (liveWorkers(model, command.parentThreadId) >= FLEET_LIMITS.maxLiveWorkers)
    return reject(
      "bad_request",
      "This coordinator already has the maximum number of live workers.",
    );
  if (ctx.hasProvider && !ctx.hasProvider(command.provider))
    return reject("bad_request", `Unknown provider ${command.provider}.`);

  const project = model.projects[parent.projectId];
  if (!project) return notFound("project", parent.projectId);

  const now = ctx.now();
  const workerId = ctx.newId("thread");
  const runtimeMode = command.runtimeMode ?? parent.runtimeMode;
  const title = command.title?.trim() || titleFromPrompt(command.prompt) || DEFAULT_TITLE;
  const group = orchestratedGroup(model, parent.id);
  const groupId = group?.id ?? ctx.newId("group");
  const threadIds = group ? [...group.threadIds, workerId] : [workerId];

  const events: Draft[] = [
    {
      type: "group.created",
      group: {
        id: groupId,
        projectId: parent.projectId,
        kind: "orchestrated",
        prompt: command.prompt,
        coordinatorThreadId: parent.id,
        threadIds,
        createdAt: group?.createdAt ?? now,
      },
    },
    {
      type: "thread.spawned",
      parentThreadId: parent.id,
      thread: {
        id: workerId,
        projectId: parent.projectId,
        title,
        provider: command.provider,
        model: command.model,
        runtimeMode,
        worktree: null,
        isolate: true,
        role: "worker",
        groupId,
        providerSessionId: null,
        queue: [],
        status: "idle",
        createdAt: now,
        updatedAt: now,
      },
    },
  ];

  const worker: Thread = {
    id: workerId,
    projectId: parent.projectId,
    title,
    provider: command.provider,
    model: command.model,
    runtimeMode,
    worktree: null,
    isolate: true,
    role: "worker",
    groupId,
    parentThreadId: parent.id,
    providerSessionId: null,
    queue: [],
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };

  const started = beginTurn(model, worker, command.prompt, ctx);
  if (!started.ok) return started;
  events.push(...started.events);
  return {
    ok: true,
    events,
    effects: [
      { kind: "worktree.create", threadId: workerId, projectRoot: project.root },
      ...started.effects,
    ],
  };
}

export function decideFanoutStart(
  model: ReadModel,
  command: CommandOf<"fanout.start">,
  ctx: DecideContext,
): PartialDecision {
  const project = model.projects[command.projectId];
  if (!project) return notFound("project", command.projectId);

  const now = ctx.now();
  const groupId = ctx.newId("group");
  const threadIds: string[] = [];
  const events: Draft[] = [];
  const effects: Effect[] = [];
  const baseTitle = command.title?.trim() || titleFromPrompt(command.prompt) || DEFAULT_TITLE;

  for (const target of command.targets) {
    if (ctx.hasProvider && !ctx.hasProvider(target.provider))
      return reject("bad_request", `Unknown provider ${target.provider}.`);
    const threadId = ctx.newId("thread");
    threadIds.push(threadId);
    events.push({
      type: "thread.created",
      thread: {
        id: threadId,
        projectId: project.id,
        title: baseTitle,
        provider: target.provider,
        model: target.model,
        runtimeMode: command.runtimeMode,
        worktree: null,
        isolate: true,
        role: "worker",
        groupId,
        providerSessionId: null,
        queue: [],
        status: "idle",
        createdAt: now,
        updatedAt: now,
      },
    });
    const thread: Thread = {
      id: threadId,
      projectId: project.id,
      title: baseTitle,
      provider: target.provider,
      model: target.model,
      runtimeMode: command.runtimeMode,
      worktree: null,
      isolate: true,
      role: "worker",
      groupId,
      providerSessionId: null,
      queue: [],
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    const started = beginTurn(model, thread, command.prompt, ctx);
    if (!started.ok) return started;
    events.push(...started.events);
    effects.push(
      { kind: "worktree.create", threadId, projectRoot: project.root },
      ...started.effects,
    );
  }

  events.unshift({
    type: "group.created",
    group: {
      id: groupId,
      projectId: project.id,
      kind: "fanout",
      prompt: command.prompt,
      threadIds,
      createdAt: now,
    },
  });

  return { ok: true, events, effects };
}

export function decideFanoutPick(
  model: ReadModel,
  command: CommandOf<"fanout.pick">,
  _ctx: DecideContext,
): PartialDecision {
  const group = model.groups[command.groupId];
  if (!group) return notFound("group", command.groupId);
  if (!group.threadIds.includes(command.threadId))
    return reject("bad_request", "That thread is not in this group.");
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  if (!thread.worktree || thread.status === "error") {
    return reject("bad_request", "That thread has no worktree to pick.");
  }
  return {
    ok: true,
    events: [{ type: "group.winnerPicked", groupId: command.groupId, threadId: command.threadId }],
    effects: [],
  };
}

export function decideThreadMerge(
  model: ReadModel,
  command: CommandOf<"thread.merge">,
  ctx: DecideContext,
): PartialDecision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  if (!thread.worktree) return reject("bad_request", "This thread has no worktree to merge.");
  if (isBusy(thread)) return reject("conflict", "Stop the running turn before merging.");
  if (thread.merge?.status === "merging")
    return reject("conflict", "A merge is already in progress for this thread.");
  const project = model.projects[thread.projectId];
  if (!project) return notFound("project", thread.projectId);

  const now = ctx.now();
  return {
    ok: true,
    events: [
      {
        type: "thread.mergeChanged",
        threadId: thread.id,
        merge: { status: "merging", at: now },
      },
    ],
    effects: [
      {
        kind: "thread.merge",
        threadId: thread.id,
        projectRoot: project.root,
        worktree: thread.worktree,
        strategy: command.strategy,
        title: thread.title,
        message: command.message,
      },
    ],
  };
}

export function decideReviewAddNote(
  model: ReadModel,
  command: CommandOf<"review.addNote">,
  ctx: DecideContext,
): PartialDecision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  const noteId = ctx.newId("note");
  return {
    ok: true,
    events: [
      {
        type: "review.noteAdded",
        note: {
          id: noteId,
          threadId: command.threadId,
          path: command.path,
          line: command.line,
          side: command.side,
          body: command.body,
          createdAt: ctx.now(),
        },
      },
    ],
    effects: [],
  };
}

export function decideReviewRemoveNote(
  model: ReadModel,
  command: CommandOf<"review.removeNote">,
  _ctx: DecideContext,
): PartialDecision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  const list = model.reviewNotes[command.threadId] ?? [];
  if (!list.some((note) => note.id === command.noteId))
    return notFound("review note", command.noteId);
  return {
    ok: true,
    events: [{ type: "review.noteRemoved", threadId: command.threadId, noteId: command.noteId }],
    effects: [],
  };
}

export function decideReviewSend(
  model: ReadModel,
  command: CommandOf<"review.send">,
  ctx: DecideContext,
): PartialDecision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  const notes = reviewNotesFor(model, command.threadId);
  const extra = command.extra?.trim() ?? "";
  if (notes.length === 0 && !extra)
    return reject("bad_request", "Add at least one review note or extra text before sending.");
  const prompt = formatReviewPrompt(notes, command.extra);
  const noteIds = notes.map((note) => note.id);
  const events: Draft[] = [];
  const effects: Effect[] = [];

  if (isBusy(thread)) {
    events.push({
      type: "queue.added",
      threadId: thread.id,
      item: { id: ctx.newId("queue"), prompt, queuedAt: ctx.now() },
    });
  } else {
    const started = beginTurn(model, thread, prompt, ctx);
    if (!started.ok) return started;
    events.push(...started.events);
    effects.push(...started.effects);
  }
  events.push({ type: "review.notesSent", threadId: thread.id, noteIds });
  return { ok: true, events, effects };
}

function orchestratedGroup(model: ReadModel, parentId: string): ThreadGroup | undefined {
  return Object.values(model.groups).find(
    (group) => group.kind === "orchestrated" && group.coordinatorThreadId === parentId,
  );
}

function liveWorkers(model: ReadModel, parentId: string): number {
  const rows = fleetRows(model);
  const byId = new Map(rows.map((row) => [row.threadId, row.status]));
  return childrenOf(model, parentId).filter((child) => {
    const status = byId.get(child.id);
    return status === "working" || status === "waiting" || status === "idle";
  }).length;
}

function beginTurn(
  model: ReadModel,
  thread: Thread,
  prompt: string,
  ctx: DecideContext,
  fromQueueId?: string,
): { ok: true; events: Draft[]; effects: Effect[] } | PartialDecision {
  const turnId = ctx.newId("turn");
  const events: Draft[] = [];
  const firstTurn = (model.turns[thread.id] ?? []).length === 0;
  if (firstTurn && thread.title === DEFAULT_TITLE) {
    const title = titleFromPrompt(prompt);
    if (title) events.push({ type: "thread.renamed", threadId: thread.id, title });
  }
  events.push({
    type: "turn.started",
    threadId: thread.id,
    turnId,
    prompt,
    provider: thread.provider,
    model: thread.model,
    checkpointBefore: checkpointRef(thread.id, turnId, "before"),
    interactionMode: thread.interactionMode ?? "default",
    ...(fromQueueId ? { fromQueueId } : {}),
  });
  return { ok: true, events, effects: [{ kind: "turn.run", threadId: thread.id, turnId }] };
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= TITLE_MAX) return line;
  return `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function isBusy(thread: Thread): boolean {
  return thread.status === "running" || thread.status === "waiting";
}

function reject(code: "bad_request" | "not_found" | "conflict", message: string): PartialDecision {
  return { ok: false, code, message };
}

function notFound(what: string, id: string): PartialDecision {
  return reject("not_found", `No ${what} with id ${id}.`);
}
