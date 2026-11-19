import type {
  AgeEvent,
  ReadModel,
  ReviewNote,
  Thread,
  ThreadGroup,
  TimelineItem,
  Turn,
} from "@wooky/contracts";

/**
 * The one projection. Pure, synchronous, no I/O. Server and every client apply
 * the same events through this function, so they cannot disagree about state.
 * Returns a new object only for the branches that changed (cheap for React).
 */
export function emptyReadModel(): ReadModel {
  return {
    seq: 0,
    projects: {},
    threads: {},
    turns: {},
    cooldowns: {},
    groups: {},
    reviewNotes: {},
  };
}

export function applyEvents(model: ReadModel, events: readonly AgeEvent[]): ReadModel {
  let next = model;
  for (const event of events) next = applyEvent(next, event);
  return next;
}

export function applyEvent(model: ReadModel, event: AgeEvent): ReadModel {
  // Events at or below the current seq were already applied (replay overlap).
  if (event.seq <= model.seq) return model;
  const next = reduce(model, event);
  return next === model ? { ...model, seq: event.seq } : { ...next, seq: event.seq };
}

function reduce(model: ReadModel, event: AgeEvent): ReadModel {
  switch (event.type) {
    case "project.added":
      return { ...model, projects: { ...model.projects, [event.project.id]: event.project } };

    case "project.removed": {
      const { [event.projectId]: _removed, ...projects } = model.projects;
      const threads: ReadModel["threads"] = {};
      const turns: ReadModel["turns"] = {};
      for (const [id, thread] of Object.entries(model.threads)) {
        if (thread.projectId === event.projectId) continue;
        threads[id] = thread;
        const list = model.turns[id];
        if (list) turns[id] = list;
      }
      const groups = Object.fromEntries(
        Object.entries(model.groups).filter(([, group]) => group.projectId !== event.projectId),
      );
      const reviewNotes = Object.fromEntries(
        Object.entries(model.reviewNotes).filter(([threadId]) => threads[threadId]),
      );
      return { ...model, projects, threads, turns, groups, reviewNotes };
    }

    case "thread.created":
      return {
        ...model,
        threads: { ...model.threads, [event.thread.id]: event.thread },
        turns: { ...model.turns, [event.thread.id]: [] },
      };

    case "thread.renamed":
      return patchThread(model, event.threadId, event.at, { title: event.title });

    case "thread.removed": {
      const { [event.threadId]: _thread, ...threads } = model.threads;
      const { [event.threadId]: _turns, ...turns } = model.turns;
      const { [event.threadId]: _notes, ...reviewNotes } = model.reviewNotes;
      return {
        ...model,
        threads,
        turns,
        reviewNotes,
        groups: detachThread(model.groups, event.threadId),
      };
    }

    case "thread.configured":
      return patchThread(model, event.threadId, event.at, {
        provider: event.provider,
        model: event.model,
        runtimeMode: event.runtimeMode,
        ...(event.handoff ? { providerSessionId: null } : {}),
        ...(event.interactionMode ? { interactionMode: event.interactionMode } : {}),
        ...(event.effort ? { effort: event.effort } : {}),
        ...(event.fastMode !== undefined ? { fastMode: event.fastMode } : {}),
        ...(event.ultracode !== undefined ? { ultracode: event.ultracode } : {}),
      });

    case "thread.sessionBound":
      return patchThread(model, event.threadId, event.at, {
        providerSessionId: event.providerSessionId,
      });

    case "thread.worktreeBound":
      return patchThread(model, event.threadId, event.at, { worktree: event.worktree });

    case "thread.worktreeFailed":
      return patchThread(model, event.threadId, event.at, {
        status: "error",
        errorMessage: event.message,
      });

    case "turn.started": {
      const turn: Turn = {
        id: event.turnId,
        threadId: event.threadId,
        prompt: event.prompt,
        provider: event.provider,
        model: event.model,
        status: "running",
        items: [],
        startedAt: event.at,
        endedAt: null,
        checkpointBefore: event.checkpointBefore,
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
        ...(event.interactionMode ? { interactionMode: event.interactionMode } : {}),
        ...(event.origin ? { origin: event.origin } : {}),
      };
      const withTurn = {
        ...model,
        turns: { ...model.turns, [event.threadId]: [...(model.turns[event.threadId] ?? []), turn] },
      };
      return patchThread(withTurn, event.threadId, event.at, { status: "running" });
    }

    case "turn.itemUpserted": {
      const isNewPlan =
        event.item.kind === "plan" &&
        !model.turns[event.threadId]?.some((turn) =>
          turn.items.some((item) => item.id === event.item.id),
        );
      const base = isNewPlan ? supersedePlans(model, event.threadId) : model;
      return patchTurn(base, event.threadId, event.turnId, (turn) => ({
        ...turn,
        items: upsertItem(turn.items, event.item),
      }));
    }

    case "turn.itemDelta":
      return patchTurn(model, event.threadId, event.turnId, (turn) => {
        const index = turn.items.findIndex((item) => item.id === event.itemId);
        const item = turn.items[index];
        if (!item || (item.kind !== "message" && item.kind !== "reasoning")) return turn;
        const items = turn.items.slice();
        items[index] = { ...item, text: item.text + event.text };
        return { ...turn, items };
      });

    case "approval.requested":
      return patchThread(model, event.threadId, event.at, { status: "waiting" });

    case "approval.resolved": {
      if (!openRequestOnRunningTurn(model, event)) return model;
      const resolved = patchTurn(model, event.threadId, event.turnId, (turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.kind === "approval" && item.requestId === event.requestId
            ? { ...item, decision: event.decision }
            : item,
        ),
      }));
      return patchThread(resolved, event.threadId, event.at, {
        status: hasOpenRequest(resolved, event.threadId) ? "waiting" : "running",
      });
    }

    case "question.requested": {
      const asked = patchTurn(model, event.threadId, event.turnId, (turn) =>
        turn.items.some((item) => item.id === event.itemId)
          ? turn
          : {
              ...turn,
              items: [
                ...turn.items,
                {
                  kind: "question",
                  id: event.itemId,
                  requestId: event.requestId,
                  questions: event.questions,
                  answers: null,
                },
              ],
            },
      );
      return patchThread(asked, event.threadId, event.at, { status: "waiting" });
    }

    case "question.resolved": {
      if (!openRequestOnRunningTurn(model, event)) return model;
      const resolved = patchTurn(model, event.threadId, event.turnId, (turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.kind === "question" && item.requestId === event.requestId
            ? event.answers === null
              ? { ...item, answers: null, dismissed: true }
              : { ...item, answers: event.answers }
            : item,
        ),
      }));
      return patchThread(resolved, event.threadId, event.at, {
        status: hasOpenRequest(resolved, event.threadId) ? "waiting" : "running",
      });
    }

    case "turn.finished": {
      const finished = patchTurn(model, event.threadId, event.turnId, (turn) => ({
        ...turn,
        status: event.status,
        endedAt: event.at,
        checkpointAfter: event.checkpointAfter,
        changedFiles: event.changedFiles,
        usage: event.usage,
        error: event.error,
        ...(event.failure === undefined ? {} : { failure: event.failure }),
        ...(event.nativeRef === undefined ? {} : { nativeRef: event.nativeRef }),
        // Approvals and questions left open when a turn ends can never be answered.
        items: turn.items.map((item) =>
          isOpenRequest(item)
            ? item.kind === "approval"
              ? { ...item, decision: "deny" as const }
              : { ...item, dismissed: true }
            : item,
        ),
      }));
      const failover = finished.threads[event.threadId]?.failover;
      // The switch limit is per prompt: a completed turn starts a fresh budget.
      const resetSwitches =
        event.status === "completed" && failover && failover.switches > 0
          ? { failover: { ...failover, switches: 0 } }
          : {};
      return patchThread(finished, event.threadId, event.at, {
        status: event.status === "failed" ? "error" : "idle",
        ...resetSwitches,
      });
    }

    case "turn.reverted": {
      const list = model.turns[event.threadId];
      if (!list) return model;
      const index = list.findIndex((turn) => turn.id === event.turnId);
      if (index < 0) return model;
      const remaining = list.slice(0, index);
      const last = remaining.at(-1)?.status;
      const status = last === "failed" ? "error" : last === "running" ? "running" : "idle";
      const reverted = { ...model, turns: { ...model.turns, [event.threadId]: remaining } };
      return patchThread(reverted, event.threadId, event.at, {
        status,
        ...(event.providerSessionId === undefined
          ? {}
          : { providerSessionId: event.providerSessionId }),
      });
    }

    case "queue.added": {
      const thread = model.threads[event.threadId];
      if (!thread) return model;
      const queue = thread.queue ?? [];
      if (queue.some((item) => item.id === event.item.id)) return model;
      return patchThread(model, event.threadId, event.at, { queue: [...queue, event.item] });
    }

    case "queue.removed": {
      const queue = model.threads[event.threadId]?.queue;
      if (!queue?.some((item) => item.id === event.queueId)) return model;
      return patchThread(model, event.threadId, event.at, {
        queue: queue.filter((item) => item.id !== event.queueId),
      });
    }

    case "provider.cooledDown": {
      const cooldowns = {
        ...(model.cooldowns ?? {}),
        [event.key]: { until: event.until, reason: event.reason },
      };
      return { ...model, cooldowns };
    }

    case "provider.cooldownCleared": {
      const cooldowns = { ...(model.cooldowns ?? {}) };
      if (!(event.key in cooldowns)) return model;
      const { [event.key]: _removed, ...rest } = cooldowns;
      return { ...model, cooldowns: rest };
    }

    case "thread.failedOver": {
      const thread = model.threads[event.threadId];
      if (!thread) return model;
      const original = thread.failover?.original ?? event.from;
      const providerChanged = event.from.provider !== event.to.provider;
      const prevReset = thread.failover?.resetAt;
      const nextReset = event.failure.resetAt;
      const resetAt =
        prevReset && nextReset
          ? prevReset > nextReset
            ? prevReset
            : nextReset
          : (nextReset ?? prevReset);
      return patchThread(model, event.threadId, event.at, {
        provider: event.to.provider,
        model: event.to.model,
        ...(providerChanged ? { providerSessionId: null } : {}),
        failover: {
          original,
          switchedAt: event.at,
          reason: event.failure.kind,
          ...(resetAt ? { resetAt } : {}),
          switches: event.switches,
        },
      });
    }

    case "thread.failoverRestored":
      return patchThread(model, event.threadId, event.at, {
        provider: event.to.provider,
        model: event.to.model,
        failover: undefined,
      });

    case "thread.spawned": {
      // One event records the worker and promotes the parent. A later spawn of the
      // same parent leaves an existing coordinator role untouched.
      const thread: Thread = {
        ...event.thread,
        role: event.thread.role ?? "worker",
        parentThreadId: event.parentThreadId,
      };
      let threads: ReadModel["threads"] = { ...model.threads, [thread.id]: thread };
      const parent = threads[event.parentThreadId];
      if (parent && parent.id !== thread.id && parent.role !== "coordinator") {
        threads = {
          ...threads,
          [parent.id]: { ...parent, role: "coordinator", updatedAt: event.at },
        };
      }
      let groups = model.groups;
      const group = thread.groupId ? groups[thread.groupId] : undefined;
      if (group && !group.threadIds.includes(thread.id)) {
        groups = {
          ...groups,
          [group.id]: { ...group, threadIds: [...group.threadIds, thread.id] },
        };
      }
      return {
        ...model,
        threads,
        groups,
        turns: { ...model.turns, [thread.id]: model.turns[thread.id] ?? [] },
      };
    }

    case "group.created":
      return { ...model, groups: { ...model.groups, [event.group.id]: event.group } };

    case "group.winnerPicked": {
      const group = model.groups[event.groupId];
      if (!group || group.winnerThreadId === event.threadId) return model;
      return {
        ...model,
        groups: {
          ...model.groups,
          [group.id]: { ...group, winnerThreadId: event.threadId },
        },
      };
    }

    case "thread.mergeChanged":
      return patchThread(model, event.threadId, event.at, { merge: event.merge });

    case "review.noteAdded": {
      const threadId = event.note.threadId;
      const notes = (model.reviewNotes[threadId] ?? []).filter((note) => note.id !== event.note.id);
      notes.push(event.note);
      return withNotes(model, threadId, notes);
    }

    case "review.noteRemoved": {
      const list = model.reviewNotes[event.threadId];
      if (!list?.some((note) => note.id === event.noteId)) return model;
      return withNotes(
        model,
        event.threadId,
        list.filter((note) => note.id !== event.noteId),
      );
    }

    case "review.notesSent": {
      const list = model.reviewNotes[event.threadId];
      if (!list) return model;
      const drop = new Set(event.noteIds);
      if (!list.some((note) => drop.has(note.id))) return model;
      return withNotes(
        model,
        event.threadId,
        list.filter((note) => !drop.has(note.id)),
      );
    }

    case "worker.reported": {
      if (!model.threads[event.workerThreadId]) return model;
      return patchThread(model, event.workerThreadId, event.at, {
        report: {
          turnId: event.turnId,
          summary: event.summary,
          ...(event.diffStat ? { diffStat: event.diffStat } : {}),
          at: event.at,
        },
      });
    }
  }
}

function withNotes(model: ReadModel, threadId: string, notes: ReviewNote[]): ReadModel {
  if (notes.length === 0) {
    if (!model.reviewNotes[threadId]) return model;
    const { [threadId]: _gone, ...reviewNotes } = model.reviewNotes;
    return { ...model, reviewNotes };
  }
  return { ...model, reviewNotes: { ...model.reviewNotes, [threadId]: notes } };
}

/** Drop a removed thread from membership, the winner, and the coordinator slot. */
function detachThread(groups: ReadModel["groups"], threadId: string): ReadModel["groups"] {
  let changed = false;
  const next: ReadModel["groups"] = {};
  for (const [id, group] of Object.entries(groups)) {
    const cleaned = withoutMember(group, threadId);
    next[id] = cleaned;
    if (cleaned !== group) changed = true;
  }
  return changed ? next : groups;
}

function withoutMember(group: ThreadGroup, threadId: string): ThreadGroup {
  const listed = group.threadIds.includes(threadId);
  const winner = group.winnerThreadId === threadId;
  const coordinator = group.coordinatorThreadId === threadId;
  if (!listed && !winner && !coordinator) return group;
  const { winnerThreadId, coordinatorThreadId, ...rest } = group;
  return {
    ...rest,
    threadIds: group.threadIds.filter((id) => id !== threadId),
    ...(winner || winnerThreadId === undefined ? {} : { winnerThreadId }),
    ...(coordinator || coordinatorThreadId === undefined ? {} : { coordinatorThreadId }),
  };
}

function isOpenRequest(item: TimelineItem): boolean {
  if (item.kind === "approval") return item.decision === null;
  if (item.kind === "question") return item.answers === null && !item.dismissed;
  return false;
}

/** A late or repeated resolve (turn ended, reverted, or already answered) changes nothing. */
function openRequestOnRunningTurn(
  model: ReadModel,
  event: { threadId: string; turnId: string; requestId: string },
): boolean {
  const turn = model.turns[event.threadId]?.findLast((candidate) => candidate.id === event.turnId);
  if (turn?.status !== "running") return false;
  return turn.items.some(
    (item) =>
      (item.kind === "approval" || item.kind === "question") &&
      item.requestId === event.requestId &&
      isOpenRequest(item),
  );
}

function hasOpenRequest(model: ReadModel, threadId: string): boolean {
  return (model.turns[threadId] ?? []).some((turn) => turn.items.some(isOpenRequest));
}

/** A new plan replaces every plan still waiting for the user's review. */
function supersedePlans(model: ReadModel, threadId: string): ReadModel {
  const list = model.turns[threadId];
  if (!list) return model;
  let changed = false;
  const turns = list.map((turn) => {
    if (!turn.items.some((item) => item.kind === "plan" && item.status === "proposed")) return turn;
    changed = true;
    return {
      ...turn,
      items: turn.items.map((item) =>
        item.kind === "plan" && item.status === "proposed"
          ? { ...item, status: "superseded" as const }
          : item,
      ),
    };
  });
  return changed ? { ...model, turns: { ...model.turns, [threadId]: turns } } : model;
}

function patchThread(
  model: ReadModel,
  threadId: string,
  at: string,
  patch: Partial<Thread>,
): ReadModel {
  const thread = model.threads[threadId];
  if (!thread) return model;
  return {
    ...model,
    threads: { ...model.threads, [threadId]: { ...thread, ...patch, updatedAt: at } },
  };
}

function patchTurn(
  model: ReadModel,
  threadId: string,
  turnId: string,
  update: (turn: Turn) => Turn,
): ReadModel {
  const list = model.turns[threadId];
  if (!list) return model;
  const index = list.findLastIndex((turn) => turn.id === turnId);
  const turn = list[index];
  if (!turn) return model;
  const updated = update(turn);
  if (updated === turn) return model;
  const turns = list.slice();
  turns[index] = updated;
  return { ...model, turns: { ...model.turns, [threadId]: turns } };
}

function upsertItem(items: readonly TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}
