import type { PendingEvent, ProviderEvent, ReadModel, Usage } from "@age/contracts";
import { activeTurn, handoffTranscript } from "@age/domain";
import type { GitService } from "../git/types.ts";
import { checkpointRef, type Effect, type StoredEffect } from "../orchestrator/effects.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { TurnInput } from "../providers/types.ts";
import type { EventStore } from "../store/event-store.ts";

export interface EffectRunner {
  enqueue(effects: readonly StoredEffect[]): void;
  /** Startup recovery: retire effects from a previous process and finish its running turns. */
  recover(): void;
  /** Resolves once every queued effect has settled. */
  idle(): Promise<void>;
  /** Aborts running turns and waits (bounded) for them to record their finish. */
  shutdown(timeoutMs?: number): Promise<void>;
}

interface RunnerDeps {
  store: EventStore;
  providers: ProviderRegistry;
  git: GitService;
  newId(prefix: string): string;
  coalesceMs?: number;
}

type Decision = "allow" | "deny";
type FinishStatus = "completed" | "interrupted" | "failed";

/**
 * Effects run in order per thread and in parallel across threads. Control effects
 * (interrupt, approval answers) bypass the queue: they steer a turn that is already
 * occupying its thread's queue.
 */
export function createEffectRunner(deps: RunnerDeps): EffectRunner {
  const { store, providers, git, newId, coalesceMs = 30 } = deps;
  const tails = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const approvals = new Map<string, (decision: Decision) => void>();
  const worktreeFailures = new Map<string, string>();
  let stopped = false;

  const append = (events: PendingEvent[]) => {
    if (!stopped && events.length > 0) store.appendInternal(events);
  };
  const markDone = (effect: StoredEffect) => {
    if (!stopped) store.markEffect(effect.id, "done");
  };
  const track = (work: Promise<void>) => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  };
  const approvalKey = (turnId: string, requestId: string) => `${turnId}\u0000${requestId}`;

  async function perform(effect: Effect): Promise<void> {
    switch (effect.kind) {
      case "turn.run":
        return runTurn(effect.threadId, effect.turnId);
      case "worktree.create":
        try {
          const worktree = await git.createWorktree(effect.projectRoot, effect.threadId);
          worktreeFailures.delete(effect.threadId);
          if (store.model.threads[effect.threadId])
            append([
              {
                type: "thread.worktreeBound",
                commandId: null,
                threadId: effect.threadId,
                worktree,
              },
            ]);
        } catch (error) {
          worktreeFailures.set(effect.threadId, messageOf(error));
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
        approvals.get(approvalKey(effect.turnId, effect.requestId))?.(effect.decision);
        return;
    }
  }

  async function runTurn(threadId: string, turnId: string): Promise<void> {
    const controller = controllers.get(turnId) ?? new AbortController();
    const { signal } = controller;
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
    const notice = (text: string) =>
      emit([
        { type: "turn.itemUpserted", ...ids, item: { kind: "notice", id: newId("notice"), text } },
      ]);

    let status: FinishStatus = "failed";
    let error: string | null = null;
    let usage: Usage | null = null;
    let cwd: string | null = null;
    let checkpoints = false;

    try {
      const worktreeFailure = worktreeFailures.get(threadId);
      const project = model.projects[thread.projectId];
      const adapter = providers.get(turn.provider);
      if (signal.aborted) throw new Interrupted();
      if (worktreeFailure)
        throw new Error(`Could not create the thread's worktree: ${worktreeFailure}`);
      if (!project) throw new Error("The project no longer exists.");
      if (!adapter) throw new Error(`The ${turn.provider} provider is not available.`);
      cwd = thread.worktree?.path ?? project.root;

      if (await git.isRepo(cwd)) {
        try {
          await git.captureCheckpoint(cwd, checkpointRef(threadId, turnId, "before"));
          checkpoints = true;
        } catch (cause) {
          notice(`Checkpoint failed, so this turn cannot be reverted: ${messageOf(cause)}`);
        }
      } else {
        notice("Not a git repository, so this turn has no checkpoint.");
      }

      const earlier = (model.turns[threadId] ?? []).filter((candidate) => candidate.id !== turnId);
      const handoffContext =
        thread.providerSessionId === null && earlier.length > 0
          ? handoffTranscript(withTurns(model, threadId, earlier), threadId)
          : null;

      const input: TurnInput = {
        threadId,
        turnId,
        cwd,
        prompt: turn.prompt,
        model: turn.model,
        runtimeMode: thread.runtimeMode,
        resumeSessionId: thread.providerSessionId,
        handoffContext,
        signal,
        requestApproval: async (request) => {
          if (thread.runtimeMode === "full") return "allow";
          if (signal.aborted) return "deny";
          const key = approvalKey(turnId, request.requestId);
          const answer = new Promise<Decision>((resolve) => {
            const onAbort = () => resolve("deny");
            signal.addEventListener("abort", onAbort, { once: true });
            approvals.set(key, (decision) => {
              signal.removeEventListener("abort", onAbort);
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
      };

      let done: Extract<ProviderEvent, { type: "done" }> | null = null;
      for await (const event of adapter.runTurn(input)) {
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
        else {
          done = event;
          break;
        }
      }
      flush();
      if (done) {
        status = done.status;
        error = done.error;
      } else if (signal.aborted) {
        status = "interrupted";
      } else {
        error = "The agent stopped without finishing its turn.";
      }
    } catch (cause) {
      flush();
      if (cause instanceof Interrupted || signal.aborted) status = "interrupted";
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
        notice(`Could not capture the end-of-turn checkpoint: ${messageOf(cause)}`);
      }
    }
    controllers.delete(turnId);
    emit([{ type: "turn.finished", ...ids, status, checkpointAfter, changedFiles, usage, error }]);
  }

  async function execute(effect: StoredEffect): Promise<void> {
    try {
      await perform(effect);
    } catch (error) {
      console.error(`Effect ${effect.kind} failed`, error);
    } finally {
      markDone(effect);
    }
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  return {
    enqueue(effects) {
      for (const effect of effects) {
        if (effect.kind === "turn.interrupt" || effect.kind === "approval.resolve") {
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
    },
    recover() {
      store.retirePendingEffects();
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
    },
    idle,
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
