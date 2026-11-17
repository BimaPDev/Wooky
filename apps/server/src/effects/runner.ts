import {
  ApprovalRequest,
  ProviderEvent,
  UserInputRequest,
  type Command,
  type PendingEvent,
  type QuestionAnswers,
  type ReadModel,
  type Usage,
  type Worktree,
} from "@age/contracts";
import { activeTurn, handoffTranscript, latestPlan } from "@age/domain";
import type { GitService } from "../git/types.ts";
import {
  checkpointRef,
  NO_CHECKPOINT_ITEM,
  type Effect,
  type StoredEffect,
} from "../orchestrator/effects.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { TurnInput } from "../providers/types.ts";
import type { EventStore } from "../store/event-store.ts";

export interface EffectRunner {
  enqueue(effects: readonly StoredEffect[]): void;
  /**
   * Startup recovery: finish turns a previous process left running and retire its turn
   * effects (never replay turn.run), but re-run its idempotent workspace effects.
   */
  recover(): void;
  /** Resolves once every queued effect has settled. */
  idle(): Promise<void>;
  /** Aborts running turns and waits (bounded) for them to record their finish. */
  shutdown(timeoutMs?: number): Promise<void>;
  /** Approval and question resolvers still waiting. Zero after a turn settles. */
  pendingRequests(): number;
}

interface RunnerDeps {
  store: EventStore;
  providers: ProviderRegistry;
  git: GitService;
  newId(prefix: string): string;
  coalesceMs?: number;
  /** Starts a queued prompt. Injected so the runner does not import the dispatcher. */
  dispatch?: (command: Command) => void;
}

type Decision = "allow" | "deny";
type FinishStatus = "completed" | "interrupted" | "failed";

const MAX_INVALID_EVENTS = 5;
const RECOVERABLE: ReadonlySet<Effect["kind"]> = new Set([
  "checkpoint.restore",
  "worktree.create",
  "worktree.remove",
  "session.rewind",
]);

/**
 * Effects run in order per thread and in parallel across threads. Control effects
 * (interrupt, approval and question answers) bypass the queue: they steer a turn that is
 * already occupying its thread's queue.
 */
export function createEffectRunner(deps: RunnerDeps): EffectRunner {
  const { store, providers, git, newId, coalesceMs = 30, dispatch } = deps;
  const tails = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const approvals = new Map<string, (decision: Decision) => void>();
  const questions = new Map<string, (answers: QuestionAnswers | null) => void>();
  let stopped = false;

  const append = (events: PendingEvent[]) => {
    if (!stopped && events.length > 0) store.appendInternal(events);
  };
  const markEffect = (effect: StoredEffect, status: "done" | "retired") => {
    if (!stopped) store.markEffect(effect.id, status);
  };
  const track = (work: Promise<void>) => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  };
  const requestKey = (turnId: string, requestId: string) => `${turnId}\u0000${requestId}`;

  async function perform(effect: Effect): Promise<void | "hold"> {
    switch (effect.kind) {
      case "turn.run":
        return runTurn(effect.threadId, effect.turnId);
      case "worktree.create":
        try {
          await ensureWorktree(effect.threadId, effect.projectRoot);
        } catch (error) {
          console.error(`Could not create a worktree for ${effect.threadId}`, error);
        }
        return;
      case "worktree.remove":
        try {
          await git.removeWorktree(effect.projectRoot, effect.worktree);
        } catch (error) {
          console.error(`Could not remove worktree ${effect.worktree.path}`, error);
        }
        return;
      case "checkpoint.restore": {
        const ids = { commandId: null, threadId: effect.threadId, turnId: effect.turnId };
        // Re-run after a crash: the revert may already be recorded.
        const turns = store.model.turns[effect.threadId] ?? [];
        if (!turns.some((turn) => turn.id === effect.turnId)) return;
        try {
          await git.restoreCheckpoint(effect.cwd, effect.ref);
          append([{ type: "turn.reverted", ...ids }]);
        } catch (error) {
          append([
            {
              type: "turn.itemUpserted",
              ...ids,
              item: {
                kind: "error",
                id: newId("error"),
                message: `Could not revert: ${messageOf(error)}`,
              },
            },
          ]);
        }
        return;
      }
      case "turn.interrupt":
        controllers.get(effect.turnId)?.abort();
        return;
      case "approval.resolve":
        approvals.get(requestKey(effect.turnId, effect.requestId))?.(effect.decision);
        return;
      case "question.resolve":
        questions.get(requestKey(effect.turnId, effect.requestId))?.(effect.answers);
        return;
      case "session.rewind":
        return rewindSession(effect);
    }
  }

  /**
   * The reverted turn must already be gone. If it is still in the model the restore
   * failed, and rewinding would desync the native session. A provider that can only
   * resume at a message keeps this effect pending until the next turn reads it.
   */
  async function rewindSession(
    effect: Extract<Effect, { kind: "session.rewind" }>,
  ): Promise<void | "hold"> {
    const turns = store.model.turns[effect.threadId] ?? [];
    if (turns.some((turn) => turn.id === effect.turnId)) return;
    const thread = store.model.threads[effect.threadId];
    if (!thread) return;
    const adapter = providers.get(thread.provider);
    const cwd = thread.worktree?.path ?? store.model.projects[thread.projectId]?.root ?? "";
    if (adapter?.rewind && thread.providerSessionId) {
      if (effect.dropTurns < 1) return;
      const result = await adapter.rewind({
        threadId: effect.threadId,
        sessionId: thread.providerSessionId,
        keepNativeRef: effect.keepNativeRef,
        dropTurns: effect.dropTurns,
        cwd,
      });
      append([
        {
          type: "thread.sessionBound",
          commandId: null,
          threadId: effect.threadId,
          providerSessionId: result.sessionId,
        },
      ]);
      return;
    }
    if (adapter?.supportsResumeAt) return "hold";
    if (thread.providerSessionId !== null) {
      append([
        {
          type: "thread.sessionBound",
          commandId: null,
          threadId: effect.threadId,
          providerSessionId: null,
        },
      ]);
    }
  }

  function consumeResumeAt(threadId: string): string | null {
    const pending = store
      .pendingEffects()
      .filter(
        (effect): effect is StoredEffect & Extract<Effect, { kind: "session.rewind" }> =>
          effect.kind === "session.rewind" && effect.threadId === threadId,
      );
    const keep = pending.at(-1)?.keepNativeRef ?? null;
    for (const effect of pending) markEffect(effect, "done");
    return pending.length > 0 ? keep : null;
  }

  function promoteHead(threadId: string): void {
    if (!dispatch) return;
    const thread = store.model.threads[threadId];
    const head = thread?.status === "idle" ? thread.queue?.[0] : undefined;
    if (!head) return;
    try {
      dispatch({
        commandId: `queue:${head.id}`,
        type: "queue.promote",
        threadId,
        queueId: head.id,
      });
    } catch (error) {
      console.error(`Could not start queued prompt ${head.id}`, error);
    }
  }

  function acceptProposedPlan(threadId: string, turnId: string): void {
    const thread = store.model.threads[threadId];
    const turn = store.model.turns[threadId]?.find((candidate) => candidate.id === turnId);
    const mode = turn?.interactionMode ?? thread?.interactionMode ?? "default";
    if (mode !== "default") return;
    const plan = latestPlan(store.model, threadId);
    if (!plan || plan.status !== "proposed") return;
    const owner = (store.model.turns[threadId] ?? []).find((candidate) =>
      candidate.items.some((item) => item.id === plan.id),
    );
    if (!owner || owner.id === turnId) return;
    append([
      {
        type: "turn.itemUpserted",
        commandId: null,
        threadId,
        turnId: owner.id,
        item: { ...plan, status: "accepted" },
      },
    ]);
  }

  /** Binds the thread's worktree, creating it when missing. Null when the thread is gone. */
  async function ensureWorktree(threadId: string, projectRoot: string): Promise<Worktree | null> {
    const thread = store.model.threads[threadId];
    if (!thread) return null;
    if (thread.worktree) return thread.worktree;
    const worktree = await git.createWorktree(projectRoot, threadId);
    if (!store.model.threads[threadId]) {
      await git.removeWorktree(projectRoot, worktree);
      return null;
    }
    append([{ type: "thread.worktreeBound", commandId: null, threadId, worktree }]);
    return worktree;
  }

  async function runTurn(threadId: string, turnId: string): Promise<void> {
    const controller = controllers.get(turnId) ?? new AbortController();
    const { signal } = controller;
    try {
      await runTurnBody(threadId, turnId, controller, signal);
    } finally {
      // A throw after questions.set never reaches the promise's finally; abort settles it.
      controller.abort();
      controllers.delete(turnId);
    }
  }

  async function runTurnBody(
    threadId: string,
    turnId: string,
    controller: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    const model = store.model;
    const thread = model.threads[threadId];
    const turn = activeTurn(model, threadId);
    if (!thread || turn?.id !== turnId) return;
    const ids = { commandId: null, threadId, turnId };

    let buffer = new Map<string, string>();
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (buffer.size === 0) return;
      const pending = buffer;
      buffer = new Map();
      append(
        [...pending].map(([itemId, text]) => ({
          type: "turn.itemDelta" as const,
          ...ids,
          itemId,
          text,
        })),
      );
    };
    const emit = (events: PendingEvent[]) => {
      flush();
      append(events);
    };
    const notice = (text: string, id = newId("notice")) =>
      emit([{ type: "turn.itemUpserted", ...ids, item: { kind: "notice", id, text } }]);
    const bestEffort = (work: () => void) => {
      try {
        work();
      } catch (cause) {
        console.error(`Could not record progress of turn ${turnId}`, cause);
      }
    };
    let unrevertable = false;
    const markUnrevertable = (text: string) => {
      unrevertable = true;
      notice(text, NO_CHECKPOINT_ITEM);
    };

    let status: FinishStatus = "failed";
    let error: string | null = null;
    let usage: Usage | null = null;
    let nativeRef: string | undefined;
    let cwd: string | null = null;
    let checkpoints = false;

    try {
      const project = model.projects[thread.projectId];
      const adapter = providers.get(turn.provider);
      if (signal.aborted) throw new Interrupted();
      if (!project) throw new Error("The project no longer exists.");
      if (!adapter) throw new Error(`The ${turn.provider} provider is not available.`);
      let worktree = thread.worktree;
      // An isolated thread never falls back to the shared project checkout.
      if (thread.isolate && !worktree) {
        try {
          worktree = await ensureWorktree(threadId, project.root);
        } catch (cause) {
          throw new Error(`Could not create the thread's worktree: ${messageOf(cause)}`, {
            cause,
          });
        }
        if (!worktree) throw new Error("The thread no longer exists.");
      }
      cwd = worktree?.path ?? project.root;

      if (await git.isRepo(cwd)) {
        try {
          await git.captureCheckpoint(cwd, checkpointRef(threadId, turnId, "before"));
          checkpoints = true;
        } catch (cause) {
          markUnrevertable(
            `Checkpoint failed, so this turn cannot be reverted: ${messageOf(cause)}`,
          );
        }
      } else {
        markUnrevertable("Not a git repository, so this turn has no checkpoint.");
      }

      acceptProposedPlan(threadId, turnId);
      const live = store.model.threads[threadId] ?? thread;
      const earlier = (store.model.turns[threadId] ?? []).filter(
        (candidate) => candidate.id !== turnId,
      );
      const handoffContext =
        live.providerSessionId === null && earlier.length > 0
          ? handoffTranscript(withTurns(store.model, threadId, earlier), threadId)
          : null;
      const resumeAt =
        adapter.supportsResumeAt && !adapter.rewind ? consumeResumeAt(threadId) : null;

      const input: TurnInput = {
        threadId,
        turnId,
        cwd,
        prompt: turn.prompt,
        model: turn.model,
        runtimeMode: live.runtimeMode,
        resumeSessionId: live.providerSessionId,
        resumeAt,
        interactionMode: turn.interactionMode ?? live.interactionMode ?? "default",
        handoffContext,
        signal,
        requestApproval: async (raw) => {
          if (signal.aborted) return "deny";
          if (live.runtimeMode === "full") return "allow";
          const parsed = ApprovalRequest.safeParse(raw);
          if (!parsed.success) {
            notice("The agent asked for an approval Wooky could not read, so it was denied.");
            return "deny";
          }
          const request = parsed.data;
          const key = requestKey(turnId, request.requestId);
          let settled = false;
          const answer = new Promise<Decision>((resolve) => {
            const onAbort = () => {
              if (settled) return;
              settled = true;
              approvals.delete(key);
              bestEffort(() =>
                emit([
                  {
                    type: "approval.resolved",
                    ...ids,
                    requestId: request.requestId,
                    decision: "deny",
                  },
                ]),
              );
              resolve("deny");
            };
            signal.addEventListener("abort", onAbort, { once: true });
            approvals.set(key, (decision) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", onAbort);
              approvals.delete(key);
              resolve(decision);
            });
          });
          const itemId = newId("approval");
          emit([
            {
              type: "turn.itemUpserted",
              ...ids,
              item: {
                kind: "approval",
                id: itemId,
                requestId: request.requestId,
                tool: request.tool,
                title: request.title,
                detail: request.detail,
                ...(request.diff === undefined ? {} : { diff: request.diff }),
                decision: null,
              },
            },
            { type: "approval.requested", ...ids, itemId, requestId: request.requestId },
          ]);
          return answer.finally(() => approvals.delete(key));
        },
        requestUserInput: async (raw) => {
          if (signal.aborted) return null;
          const parsed = UserInputRequest.safeParse(raw);
          if (!parsed.success) {
            notice("The agent asked a question Wooky could not read, so it was dismissed.");
            return null;
          }
          const request = parsed.data;
          const key = requestKey(turnId, request.requestId);
          let settled = false;
          const answer = new Promise<QuestionAnswers | null>((resolve) => {
            const onAbort = () => {
              if (settled) return;
              settled = true;
              questions.delete(key);
              bestEffort(() =>
                emit([
                  {
                    type: "question.resolved",
                    ...ids,
                    requestId: request.requestId,
                    answers: null,
                  },
                ]),
              );
              resolve(null);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            questions.set(key, (answers) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", onAbort);
              questions.delete(key);
              resolve(answers);
            });
          });
          emit([
            {
              type: "question.requested",
              ...ids,
              itemId: newId("question"),
              requestId: request.requestId,
              questions: request.questions,
            },
          ]);
          return answer.finally(() => questions.delete(key));
        },
      };

      let done: Extract<ProviderEvent, { type: "done" }> | null = null;
      let invalid = 0;
      for await (const raw of adapter.runTurn(input)) {
        const parsed = ProviderEvent.safeParse(raw);
        if (!parsed.success) {
          console.error(`Dropped an invalid ${turn.provider} event`, parsed.error.message);
          if (++invalid >= MAX_INVALID_EVENTS) {
            controller.abort();
            throw new UnreadableStream();
          }
          notice("Wooky could not read an event from the agent, so it was skipped.");
          continue;
        }
        const event = parsed.data;
        if (event.type === "delta") {
          buffer.set(event.itemId, (buffer.get(event.itemId) ?? "") + event.text);
          timer ??= setTimeout(flush, coalesceMs);
          continue;
        }
        flush();
        if (event.type === "session")
          append([
            {
              type: "thread.sessionBound",
              commandId: null,
              threadId,
              providerSessionId: event.sessionId,
            },
          ]);
        else if (event.type === "item")
          append([{ type: "turn.itemUpserted", ...ids, item: event.item }]);
        else if (event.type === "usage") usage = event.usage;
        else if (event.type === "plan")
          append([
            {
              type: "turn.itemUpserted",
              ...ids,
              item: {
                kind: "plan",
                id: event.itemId,
                markdown: event.markdown,
                status: "proposed",
              },
            },
          ]);
        else {
          done = event;
          break;
        }
      }
      flush();
      if (done) {
        status = done.status;
        error = done.error;
        nativeRef = done.nativeRef;
      } else if (signal.aborted) {
        status = "interrupted";
      } else {
        error = "The agent stopped without finishing its turn.";
      }
    } catch (cause) {
      bestEffort(flush);
      if (cause instanceof UnreadableStream) error = cause.message;
      else if (cause instanceof Interrupted || signal.aborted) status = "interrupted";
      else error = messageOf(cause);
    }

    let checkpointAfter: string | null = null;
    let changedFiles: string[] = [];
    if (checkpoints && cwd) {
      try {
        const before = checkpointRef(threadId, turnId, "before");
        checkpointAfter = await git.captureCheckpoint(
          cwd,
          checkpointRef(threadId, turnId, "after"),
        );
        changedFiles = (await git.diff(cwd, before, checkpointAfter)).map((file) => file.path);
      } catch (cause) {
        bestEffort(() =>
          notice(`Could not capture the end-of-turn checkpoint: ${messageOf(cause)}`),
        );
      }
    }
    if (!checkpoints && !unrevertable)
      bestEffort(() => markUnrevertable("This turn has no checkpoint, so it cannot be reverted."));

    const finished: PendingEvent = {
      type: "turn.finished",
      ...ids,
      status,
      checkpointAfter,
      changedFiles,
      usage,
      error,
      ...(nativeRef === undefined ? {} : { nativeRef }),
    };
    try {
      emit([finished]);
    } catch (first) {
      console.error(`Could not record the end of turn ${turnId}; retrying once`, first);
      try {
        append([finished]);
      } catch (second) {
        console.error(
          `TURN ${turnId} IS STILL MARKED RUNNING: its finish could not be recorded. ` +
            "It will be finished as interrupted on the next start.",
          second,
        );
      }
    }
    const recorded = store.model.turns[threadId]?.find((candidate) => candidate.id === turnId);
    if (recorded?.status === "completed") promoteHead(threadId);
  }

  async function execute(effect: StoredEffect): Promise<void> {
    let status: "done" | "retired" | "hold" = "done";
    try {
      if ((await perform(effect)) === "hold") status = "hold";
    } catch (error) {
      console.error(`Effect ${effect.kind} failed`, error);
      // The store has no failed status; retired keeps a failure from reading as done.
      status = "retired";
    }
    if (status !== "hold") markEffect(effect, status);
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  function enqueue(effects: readonly StoredEffect[]) {
    for (const effect of effects) {
      if (
        effect.kind === "turn.interrupt" ||
        effect.kind === "approval.resolve" ||
        effect.kind === "question.resolve"
      ) {
        track(execute(effect));
        continue;
      }
      if (effect.kind === "turn.run") controllers.set(effect.turnId, new AbortController());
      const next = (tails.get(effect.threadId) ?? Promise.resolve()).then(() => execute(effect));
      tails.set(effect.threadId, next);
      void next.finally(() => {
        if (tails.get(effect.threadId) === next) tails.delete(effect.threadId);
      });
      track(next);
    }
  }

  return {
    enqueue,
    recover() {
      const finished: PendingEvent[] = [];
      for (const threadId of Object.keys(store.model.threads)) {
        const turn = activeTurn(store.model, threadId);
        if (!turn) continue;
        finished.push({
          type: "turn.finished",
          commandId: null,
          threadId,
          turnId: turn.id,
          status: "interrupted",
          checkpointAfter: null,
          changedFiles: [],
          usage: null,
          error: "The server stopped while this turn was running.",
        });
      }
      append(finished);
      const rerun: StoredEffect[] = [];
      for (const effect of store.pendingEffects()) {
        if (RECOVERABLE.has(effect.kind)) rerun.push(effect);
        else store.markEffect(effect.id, "retired");
      }
      enqueue(rerun);
      const busyRewind = new Set(
        store
          .pendingEffects()
          .filter(
            (effect) => effect.kind === "checkpoint.restore" || effect.kind === "session.rewind",
          )
          .map((effect) => effect.threadId),
      );
      for (const threadId of Object.keys(store.model.threads)) {
        if (busyRewind.has(threadId)) continue;
        const last = store.model.turns[threadId]?.at(-1);
        if (store.model.threads[threadId]?.status === "idle" && last?.status === "completed")
          promoteHead(threadId);
      }
    },
    idle,
    pendingRequests: () => approvals.size + questions.size,
    async shutdown(timeoutMs = 5_000) {
      for (const controller of controllers.values()) controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([idle(), timeout]);
      clearTimeout(timer);
      stopped = true;
    },
  };
}

class Interrupted extends Error {}

class UnreadableStream extends Error {
  constructor() {
    super("The agent sent too many unreadable events, so the turn was stopped.");
  }
}

function withTurns(
  model: ReadModel,
  threadId: string,
  turns: ReadModel["turns"][string],
): ReadModel {
  return { ...model, turns: { ...model.turns, [threadId]: turns } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
