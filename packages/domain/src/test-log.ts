import type { AgeEvent, PendingEvent, ReadModel, Thread, TimelineItem } from "@age/contracts";
import { applyEvents, emptyReadModel } from "./project.ts";

type Draft = PendingEvent extends infer E
  ? E extends unknown
    ? Omit<E, "commandId">
    : never
  : never;

/** Builds an event log for tests: seq and a minute-per-event clock are assigned in order. */
export function testLog() {
  const events: AgeEvent[] = [];
  const log = {
    events,
    push(...drafts: Draft[]) {
      for (const draft of drafts) {
        const seq = events.length + 1;
        const at = new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString();
        events.push({ commandId: null, ...draft, seq, at } as AgeEvent);
      }
      return log;
    },
    model(): ReadModel {
      return applyEvents(emptyReadModel(), events);
    },
    project(id: string, root: string) {
      return log.push({
        type: "project.added",
        project: { id, name: id, root, createdAt: "2026-01-01T00:00:00.000Z" },
      });
    },
    thread(id: string, projectId: string, extra: Partial<Thread> = {}) {
      return log.push({
        type: "thread.created",
        thread: {
          id,
          projectId,
          title: id,
          provider: "demo",
          model: "demo",
          runtimeMode: "approve",
          worktree: null,
          providerSessionId: null,
          queue: [],
          status: "idle",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ...extra,
        },
      });
    },
    start(
      threadId: string,
      turnId: string,
      extra: Partial<Extract<Draft, { type: "turn.started" }>> = {},
    ) {
      return log.push({
        type: "turn.started",
        threadId,
        turnId,
        prompt: `prompt ${turnId}`,
        provider: "demo",
        model: "demo",
        checkpointBefore: null,
        ...extra,
      });
    },
    item(threadId: string, turnId: string, item: TimelineItem) {
      return log.push({ type: "turn.itemUpserted", threadId, turnId, item });
    },
    finish(
      threadId: string,
      turnId: string,
      extra: Partial<Extract<Draft, { type: "turn.finished" }>> = {},
    ) {
      return log.push({
        type: "turn.finished",
        threadId,
        turnId,
        status: "completed",
        checkpointAfter: null,
        changedFiles: [],
        usage: null,
        error: null,
        ...extra,
      });
    },
  };
  return log;
}

export const question = (
  id: string,
  requestId: string,
): Extract<TimelineItem, { kind: "question" }> => ({
  kind: "question",
  id,
  requestId,
  questions: [
    {
      id: "db",
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite", description: "Single file" }],
      multiSelect: false,
      allowCustom: true,
    },
  ],
  answers: null,
});

export const plan = (
  id: string,
  markdown: string,
  status: "proposed" | "accepted" | "superseded" = "proposed",
): TimelineItem => ({ kind: "plan", id, markdown, status });
