import {
  FLEET_LIMITS,
  type DiffStat,
  type PendingEvent,
  type ReadModel,
  type Thread,
} from "@age/contracts";
import { formatWorkerReport } from "@age/domain";
import type { GitService } from "../git/types.ts";
import type { EventStore } from "../store/event-store.ts";

export function workerAlreadyReported(
  store: EventStore,
  workerId: string,
  turnId: string,
): boolean {
  return store
    .eventsAfter(0)
    .some(
      (event) =>
        event.type === "worker.reported" &&
        event.workerThreadId === workerId &&
        event.turnId === turnId,
    );
}

export function shouldReportWorker(
  thread: Thread,
  status: "completed" | "interrupted" | "failed",
): boolean {
  if (!thread.parentThreadId || thread.role !== "worker") return false;
  if (status === "interrupted") return false;
  return true;
}

export function turnSummary(
  model: ReadModel,
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" | "failed",
  error: string | null,
): string {
  if (status === "failed")
    return (error ?? "The turn failed.").slice(0, FLEET_LIMITS.maxReportSummary);
  const turn = (model.turns[threadId] ?? []).find((candidate) => candidate.id === turnId);
  const messages = (turn?.items ?? []).filter(
    (item): item is Extract<typeof item, { kind: "message" }> =>
      item.kind === "message" && item.role === "assistant",
  );
  const text = messages.at(-1)?.text?.trim() ?? "";
  const summary =
    text.length > 0 ? text : status === "completed" ? "Turn completed." : "Turn finished.";
  return summary.slice(0, FLEET_LIMITS.maxReportSummary);
}

export async function workerDiffStat(
  git: GitService,
  projectRoot: string,
  branch: string,
): Promise<DiffStat | undefined> {
  try {
    const stat = await git.diffBranchStat(projectRoot, branch);
    return stat ?? undefined;
  } catch {
    return undefined;
  }
}

export function buildWorkerReportEvents(input: {
  coordinatorThreadId: string;
  worker: Thread;
  turnId: string;
  summary: string;
  diffStat?: DiffStat;
}): PendingEvent[] {
  return [
    {
      type: "worker.reported",
      commandId: null,
      coordinatorThreadId: input.coordinatorThreadId,
      workerThreadId: input.worker.id,
      turnId: input.turnId,
      summary: input.summary,
      ...(input.diffStat ? { diffStat: input.diffStat } : {}),
    },
  ];
}

export function coordinatorFollowUpPrompt(input: {
  worker: Thread;
  turnId: string;
  summary: string;
  diffStat?: DiffStat;
}): string {
  return formatWorkerReport({
    workerThreadId: input.worker.id,
    title: input.worker.title === "New thread" ? undefined : input.worker.title,
    turnId: input.turnId,
    summary: input.summary,
    diffStat: input.diffStat,
  });
}
