import { basename, isAbsolute, normalize, sep } from "node:path";
import type {
  Command,
  CommandOf,
  FailoverSettings,
  ModelTarget,
  TurnOrigin,
  PendingEvent,
  ProviderCapabilities,
  ProviderKind,
  QuestionAnswers,
  ReadModel,
  Thread,
  UserQuestion,
} from "@age/contracts";
import {
  activeTurn,
  pendingApprovals,
  pendingQuestions,
  resumePoint,
  shouldSwitchBack,
  threadsSharingWorkspace,
} from "@age/domain";
import { cooledDownIfNeeded, expiredCooldownClears } from "../failover/cooldown.ts";
import {
  decideFanoutPick,
  decideFanoutStart,
  decideReviewAddNote,
  decideReviewRemoveNote,
  decideReviewSend,
  decideThreadMerge,
  decideThreadSpawn,
} from "./fleet-decide.ts";
import { checkpointRef, NO_CHECKPOINT_ITEM, type Effect } from "./effects.ts";

export interface DecideContext {
  now(): string;
  newId(prefix: string): string;
  /** Known provider capabilities. A missing flag means the provider cannot do that. */
  capabilities(provider: ProviderKind): ProviderCapabilities | undefined;
  /** Adapters registered on this server. */
  hasProvider?(provider: ProviderKind): boolean;
  failoverSettings: FailoverSettings;
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
      const interactionMode = command.interactionMode ?? thread.interactionMode ?? "default";
      if (interactionMode === "plan" && !supportsPlan(ctx, provider))
        return reject("bad_request", "This provider does not support plan mode.");
      return accept(command, [
        {
          type: "thread.configured",
          threadId: thread.id,
          provider,
          model: command.model ?? thread.model,
          runtimeMode: command.runtimeMode ?? thread.runtimeMode,
          handoff: provider !== thread.provider,
          ...(command.interactionMode ? { interactionMode: command.interactionMode } : {}),
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
      return respondToQuestion(model, command);
    case "queue.remove":
      return removeQueued(model, command);
    case "queue.promote":
      return promoteQueued(model, command, ctx);
    case "turn.revert":
      return revertTurn(model, command);
    case "thread.failover":
      return threadFailover(model, command, ctx);
    case "thread.spawn":
      return wrapFleet(command, decideThreadSpawn(model, command, ctx));
    case "fanout.start":
      return wrapFleet(command, decideFanoutStart(model, command, ctx));
    case "fanout.pick":
      return wrapFleet(command, decideFanoutPick(model, command, ctx));
    case "thread.merge":
      return wrapFleet(command, decideThreadMerge(model, command, ctx));
    case "review.addNote":
      return wrapFleet(command, decideReviewAddNote(model, command, ctx));
    case "review.removeNote":
      return wrapFleet(command, decideReviewRemoveNote(model, command, ctx));
    case "review.send":
      return wrapFleet(command, decideReviewSend(model, command, ctx));
  }
}

function wrapFleet(command: Command, decision: ReturnType<typeof decideThreadSpawn>): Decision {
  if (!decision.ok) return reject(decision.code, decision.message);
  return accept(command, decision.events, decision.effects);
}

function respondToQuestion(model: ReadModel, command: CommandOf<"question.respond">): Decision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  const asked = (model.turns[thread.id] ?? []).some((turn) =>
    turn.items.some((item) => item.kind === "question" && item.requestId === command.requestId),
  );
  if (!asked) return notFound("question", command.requestId);
  const turn = activeTurn(model, thread.id);
  const open = pendingQuestions(model, thread.id).find(
    (item) => item.requestId === command.requestId,
  );
  if (!turn || !open) return reject("conflict", "This question was already answered or dismissed.");
  if (command.answers !== null) {
    const problem = invalidAnswers(open.questions, command.answers);
    if (problem) return reject("bad_request", problem);
  }
  const ids = { threadId: thread.id, turnId: turn.id, requestId: command.requestId };
  return accept(
    command,
    [{ type: "question.resolved", ...ids, answers: command.answers }],
    [{ kind: "question.resolve", ...ids, answers: command.answers }],
  );
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
  if (isBusy(thread)) {
    if (command.whenBusy !== "queue")
      return reject("conflict", "A turn is already running on this thread.");
    return accept(command, [
      {
        type: "queue.added",
        threadId: thread.id,
        item: { id: ctx.newId("queue"), prompt: command.prompt, queuedAt: ctx.now() },
      },
    ]);
  }
  const prelude = failoverPrelude(model, ctx);
  const active =
    thread.failover && ctx.failoverSettings.switchBack && shouldSwitchBack(thread, model, ctx.now())
      ? switchBackThenStart(model, thread, command.prompt, ctx)
      : beginTurn(model, thread, command.prompt, ctx);
  if (!active.ok) return active;
  return accept(command, [...prelude, ...active.events], active.effects);
}

function removeQueued(model: ReadModel, command: CommandOf<"queue.remove">): Decision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  if (!thread.queue?.some((item) => item.id === command.queueId))
    return notFound("queued prompt", command.queueId);
  return accept(command, [
    { type: "queue.removed", threadId: thread.id, queueId: command.queueId, reason: "removed" },
  ]);
}

function promoteQueued(
  model: ReadModel,
  command: CommandOf<"queue.promote">,
  ctx: DecideContext,
): Decision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  if (isBusy(thread)) return reject("conflict", "A turn is already running on this thread.");
  const item = thread.queue?.find((queued) => queued.id === command.queueId);
  if (!item) return notFound("queued prompt", command.queueId);
  const prelude = failoverPrelude(model, ctx);
  const started =
    thread.failover && ctx.failoverSettings.switchBack && shouldSwitchBack(thread, model, ctx.now())
      ? switchBackThenStart(model, thread, item.prompt, ctx, item.id)
      : beginTurn(model, thread, item.prompt, ctx, item.id);
  if (!started.ok) return started;
  return accept(
    command,
    [
      { type: "queue.removed", threadId: thread.id, queueId: item.id, reason: "started" },
      ...prelude,
      ...started.events,
    ],
    started.effects,
  );
}

function threadFailover(
  model: ReadModel,
  command: CommandOf<"thread.failover">,
  ctx: DecideContext,
): Decision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  if (isBusy(thread)) return reject("conflict", "Stop the running turn before failing over.");
  if (thread.provider === command.to.provider && thread.model === command.to.model)
    return reject("bad_request", "Failover target is already the active model.");
  if (ctx.hasProvider && !ctx.hasProvider(command.to.provider))
    return reject("bad_request", `Unknown provider ${command.to.provider}.`);

  const from: ModelTarget = command.from ?? {
    provider: thread.provider,
    model: thread.model,
  };
  if (thread.provider !== from.provider || thread.model !== from.model)
    return reject("conflict", "The thread has moved on from the failed target.");

  if (command.failedTurnId) {
    const latest = (model.turns[thread.id] ?? []).at(-1);
    if (!latest || latest.id !== command.failedTurnId)
      return reject("conflict", "That failure is no longer the latest turn.");
    if (latest.status !== "failed") return reject("conflict", "That turn did not fail.");
    if (latest.provider !== from.provider || latest.model !== from.model)
      return reject("conflict", "The failed turn does not match the failed target.");
  }

  const now = ctx.now();
  const events: Draft[] = [...failoverPrelude(model, ctx)];
  const cooled = cooledDownIfNeeded(model, from, command.failure, now);
  if (cooled) events.push(cooled);

  const handoff = command.to.provider !== thread.provider;
  const nextThread: Thread = {
    ...thread,
    provider: command.to.provider,
    model: command.to.model,
    ...(handoff ? { providerSessionId: null } : {}),
  };
  const started = beginTurn(model, nextThread, command.retryPrompt, ctx, undefined, {
    kind: "failover",
    from,
    to: command.to,
    failure: command.failure,
    switches: (thread.failover?.switches ?? 0) + 1,
  });
  if (!started.ok) return accept(command, events, []);

  events.push(configuredDraft(thread, command.to.provider, command.to.model, handoff));
  events.push({
    type: "thread.failedOver",
    threadId: thread.id,
    from,
    to: command.to,
    failure: command.failure,
    switches: (thread.failover?.switches ?? 0) + 1,
  });
  return accept(command, [...events, ...started.events], started.effects);
}

function switchBackThenStart(
  model: ReadModel,
  thread: Thread,
  prompt: string,
  ctx: DecideContext,
  fromQueueId?: string,
): { ok: true; events: Draft[]; effects: Effect[] } | Rejection {
  const original = thread.failover?.original;
  if (!original) return reject("conflict", "This thread has no failover state to restore.");
  const events: Draft[] = [
    configuredDraft(
      thread,
      original.provider,
      original.model,
      original.provider !== thread.provider,
    ),
    { type: "thread.failoverRestored", threadId: thread.id, to: original },
  ];
  const restored: Thread = {
    ...thread,
    provider: original.provider,
    model: original.model,
    providerSessionId: original.provider !== thread.provider ? null : thread.providerSessionId,
    failover: undefined,
  };
  const started = beginTurn(model, restored, prompt, ctx, fromQueueId, {
    kind: "restore",
    from: { provider: thread.provider, model: thread.model },
    to: original,
  });
  if (!started.ok) return started;
  return { ok: true, events: [...events, ...started.events], effects: started.effects };
}

function failoverPrelude(model: ReadModel, ctx: DecideContext): Draft[] {
  return expiredCooldownClears(model, ctx.now());
}

function configuredDraft(
  thread: Thread,
  provider: ProviderKind,
  modelName: string,
  handoff: boolean,
): Draft {
  return {
    type: "thread.configured",
    threadId: thread.id,
    provider,
    model: modelName,
    runtimeMode: thread.runtimeMode,
    handoff,
    ...(thread.interactionMode ? { interactionMode: thread.interactionMode } : {}),
  };
}

function beginTurn(
  model: ReadModel,
  thread: Thread,
  prompt: string,
  ctx: DecideContext,
  fromQueueId?: string,
  origin?: TurnOrigin,
): { ok: true; events: Draft[]; effects: Effect[] } | Rejection {
  if ((thread.interactionMode ?? "default") === "plan" && !supportsPlan(ctx, thread.provider))
    return reject("bad_request", "This provider does not support plan mode.");
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
    ...(origin ? { origin } : {}),
  });
  return { ok: true, events, effects: [{ kind: "turn.run", threadId: thread.id, turnId }] };
}

function revertTurn(model: ReadModel, command: CommandOf<"turn.revert">): Decision {
  const thread = model.threads[command.threadId];
  if (!thread) return notFound("thread", command.threadId);
  const turns = model.turns[thread.id] ?? [];
  const turn = turns.find((candidate) => candidate.id === command.turnId);
  if (!turn) return notFound("turn", command.turnId);
  if (isBusy(thread)) return reject("conflict", "Stop the running turn before reverting.");
  const index = turns.findIndex((candidate) => candidate.id === turn.id);
  const rewind: Effect = {
    kind: "session.rewind",
    threadId: thread.id,
    turnId: turn.id,
    keepNativeRef: resumePoint(model, thread.id, turn.id),
    dropTurns: Math.max(1, turns.length - index),
  };
  if (command.restoreFiles === false) {
    return accept(
      command,
      [
        {
          type: "turn.reverted",
          threadId: thread.id,
          turnId: turn.id,
          restoredFiles: false,
        },
      ],
      [rewind],
    );
  }
  if (sharedWorkspaceBlocksRestore(model, thread.id, turn.startedAt)) {
    return reject(
      "conflict",
      "Another thread is using this folder, so files were not restored. Conversation-only revert is available.",
    );
  }
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
      rewind,
    ],
  );
}

function sharedWorkspaceBlocksRestore(
  model: ReadModel,
  threadId: string,
  startedAt: string,
): boolean {
  return threadsSharingWorkspace(model, threadId).some((other) => {
    if (other.status === "running" || other.status === "waiting") return true;
    return (model.turns[other.id] ?? []).some((turn) => turn.startedAt > startedAt);
  });
}

function supportsPlan(ctx: DecideContext, provider: ProviderKind): boolean {
  return ctx.capabilities(provider)?.planMode === true;
}

function invalidAnswers(
  questions: readonly UserQuestion[],
  answers: QuestionAnswers,
): string | null {
  const known = new Map(questions.map((question) => [question.id, question]));
  const entries = Object.entries(answers);
  if (entries.length === 0) return "Answer the question before sending.";
  for (const [id, chosen] of entries) {
    const question = known.get(id);
    if (!question) return `Unknown question ${id}.`;
    if (chosen.length === 0) return "Choose an answer.";
    if (!question.multiSelect && chosen.length > 1) return "This question accepts one answer.";
    if (!question.allowCustom) {
      const labels = new Set(question.options.map((option) => option.label));
      if (chosen.some((answer) => !labels.has(answer)))
        return "That answer is not one of the options.";
    }
  }
  return null;
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
