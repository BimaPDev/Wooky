import { basename, isAbsolute, normalize, sep } from "node:path";
import type { Command, CommandOf, PendingEvent, ReadModel, Thread } from "@age/contracts";
import { activeTurn, pendingApprovals } from "@age/domain";
import { checkpointRef, NO_CHECKPOINT_ITEM, type Effect } from "./effects.ts";

export interface DecideContext {
  now(): string;
  newId(prefix: string): string;
}

export type Rejection = {
  ok: false;
  code: "bad_request" | "not_found" | "conflict";
  message: string;
};
export type Decision = { ok: true; events: PendingEvent[]; effects: Effect[] } | Rejection;

const DEFAULT_TITLE = "New thread";
const TITLE_MAX = 60;

/** Pure: validates a command against the read model. No I/O, clock or randomness outside ctx. */
export function decide(model: ReadModel, command: Command, ctx: DecideContext): Decision {
  switch (command.type) {
    case "project.add":
      return addProject(model, command, ctx);
    case "project.remove":
      return removeProject(model, command);
    case "thread.create":
      return createThread(model, command, ctx);
    case "thread.rename": {
      const thread = model.threads[command.threadId];
      if (!thread) return notFound("thread", command.threadId);
      const title = command.title.trim();
      if (!title) return reject("bad_request", "Title must not be empty.");
      return accept(command, [{ type: "thread.renamed", threadId: thread.id, title }]);
    }
    case "thread.remove": {
      const thread = model.threads[command.threadId];
      if (!thread) return notFound("thread", command.threadId);
      if (isBusy(thread)) return reject("conflict", "Stop the running turn before removing.");
      const project = model.projects[thread.projectId];
      const effects: Effect[] =
        thread.worktree && project
          ? [
              {
                kind: "worktree.remove",
                threadId: thread.id,
                projectRoot: project.root,
                worktree: thread.worktree,
              },
            ]
          : [];
      return accept(command, [{ type: "thread.removed", threadId: thread.id }], effects);
    }
    case "thread.configure": {
      const thread = model.threads[command.threadId];
      if (!thread) return notFound("thread", command.threadId);
      if (isBusy(thread)) return reject("conflict", "Stop the running turn before reconfiguring.");
      const provider = command.provider ?? thread.provider;
      return accept(command, [
        {
          type: "thread.configured",
          threadId: thread.id,
          provider,
          model: command.model ?? thread.model,
          runtimeMode: command.runtimeMode ?? thread.runtimeMode,
          handoff: provider !== thread.provider,
        },
      ]);
    }
    case "turn.start":
      return startTurn(model, command, ctx);
    case "turn.interrupt": {
      const thread = model.threads[command.threadId];
      if (!thread) return notFound("thread", command.threadId);
      const turn = activeTurn(model, thread.id);
      if (!isBusy(thread) || !turn) return reject("conflict", "No turn is running.");
      return accept(
        command,
        [],
        [{ kind: "turn.interrupt", threadId: thread.id, turnId: turn.id }],
      );
    }
    case "approval.respond": {
      const thread = model.threads[command.threadId];
      if (!thread) return notFound("thread", command.threadId);
      const turn = activeTurn(model, thread.id);
      const pending = pendingApprovals(model, thread.id).some(
        (item) => item.kind === "approval" && item.requestId === command.requestId,
      );
      if (!turn || !pending) return notFound("approval", command.requestId);
      const ids = { threadId: thread.id, turnId: turn.id, requestId: command.requestId };
      return accept(
        command,
        [{ type: "approval.resolved", ...ids, decision: command.decision }],
        [{ kind: "approval.resolve", ...ids, decision: command.decision }],
      );
    }
    case "question.respond":
    case "queue.remove":
    case "queue.promote":
      return reject("bad_request", `${command.type} is not supported yet.`);
    case "turn.revert": {
      const thread = model.threads[command.threadId];
      if (!thread) return notFound("thread", command.threadId);
      const turn = model.turns[thread.id]?.find((candidate) => candidate.id === command.turnId);
      if (!turn) return notFound("turn", command.turnId);
      if (isBusy(thread)) return reject("conflict", "Stop the running turn before reverting.");
      if (!turn.checkpointBefore || turn.items.some((item) => item.id === NO_CHECKPOINT_ITEM))
        return reject("conflict", "This turn has no checkpoint, so it cannot be reverted.");
      const cwd = workspaceOf(model, thread);
      if (!cwd) return notFound("project", thread.projectId);
      return accept(
        command,
        [],
        [
          {
            kind: "checkpoint.restore",
            threadId: thread.id,
            turnId: turn.id,
            cwd,
            ref: turn.checkpointBefore,
          },
        ],
      );
    }
  }
}

function addProject(
  model: ReadModel,
  command: CommandOf<"project.add">,
  ctx: DecideContext,
): Decision {
  if (!isAbsolute(command.root)) return reject("bad_request", "Project root must be absolute.");
  const root = stripTrailingSep(normalize(command.root));
  if (Object.values(model.projects).some((project) => project.root === root))
    return reject("conflict", `${root} is already a project.`);
  const name = command.name?.trim() || basename(root) || root;
  return accept(command, [
    {
      type: "project.added",
      project: { id: ctx.newId("project"), name, root, createdAt: ctx.now() },
    },
  ]);
}

function removeProject(model: ReadModel, command: CommandOf<"project.remove">): Decision {
  const project = model.projects[command.projectId];
  if (!project) return notFound("project", command.projectId);
  const threads = Object.values(model.threads).filter((thread) => thread.projectId === project.id);
  if (threads.some(isBusy))
    return reject("conflict", "Stop the running turns in this project first.");
  const effects: Effect[] = threads.flatMap((thread) =>
    thread.worktree
      ? [
          {
            kind: "worktree.remove" as const,
            threadId: thread.id,
            projectRoot: project.root,
            worktree: thread.worktree,
          },
        ]
      : [],
  );
  return accept(command, [{ type: "project.removed", projectId: project.id }], effects);
}

function createThread(
  model: ReadModel,
  command: CommandOf<"thread.create">,
  ctx: DecideContext,
): Decision {
  const project = model.projects[command.projectId];
  if (!project) return notFound("project", command.projectId);
  const now = ctx.now();
  const threadId = ctx.newId("thread");
  const effects: Effect[] = command.isolate
    ? [{ kind: "worktree.create", threadId, projectRoot: project.root }]
    : [];
  return accept(
    command,
    [
      {
        type: "thread.created",
        thread: {
          id: threadId,
          projectId: project.id,
          title: command.title?.trim() || DEFAULT_TITLE,
          provider: command.provider,
          model: command.model,
          runtimeMode: command.runtimeMode,
          worktree: null,
          ...(command.isolate ? { isolate: true } : {}),
          providerSessionId: null,
          queue: [],
          status: "idle",
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
    effects,
  );
}

function startTurn(
  model: ReadModel,
  command: CommandOf<"turn.start">,
  ctx: DecideContext,
): Decision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  if (isBusy(thread)) return reject("conflict", "A turn is already running on this thread.");
  const turnId = ctx.newId("turn");
  const events: Draft[] = [];
  const firstTurn = (model.turns[thread.id] ?? []).length === 0;
  if (firstTurn && thread.title === DEFAULT_TITLE) {
    const title = titleFromPrompt(command.prompt);
    if (title) events.push({ type: "thread.renamed", threadId: thread.id, title });
  }
  events.push({
    type: "turn.started",
    threadId: thread.id,
    turnId,
    prompt: command.prompt,
    provider: thread.provider,
    model: thread.model,
    checkpointBefore: checkpointRef(thread.id, turnId, "before"),
  });
  return accept(command, events, [{ kind: "turn.run", threadId: thread.id, turnId }]);
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= TITLE_MAX) return line;
  return `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function workspaceOf(model: ReadModel, thread: Thread): string | null {
  return thread.worktree?.path ?? model.projects[thread.projectId]?.root ?? null;
}

function isBusy(thread: Thread): boolean {
  return thread.status === "running" || thread.status === "waiting";
}

function stripTrailingSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

type Draft = PendingEvent extends infer E
  ? E extends unknown
    ? Omit<E, "commandId">
    : never
  : never;

/** Stamps every event with the command that caused it. */
function accept(command: Command, events: Draft[], effects: Effect[] = []): Decision {
  return {
    ok: true,
    events: events.map((event) => ({ ...event, commandId: command.commandId }) as PendingEvent),
    effects,
  };
}

function reject(code: Rejection["code"], message: string): Rejection {
  return { ok: false, code, message };
}

function notFound(what: string, id: string): Rejection {
  return reject("not_found", `No ${what} with id ${id}.`);
}
