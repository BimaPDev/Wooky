import type { PendingEvent } from "@wooky/contracts";
import type { GitService } from "../git/types.ts";
import type { EventStore } from "../store/event-store.ts";
import {
  buildWorkerReportEvents,
  shouldReportWorker,
  turnSummary,
  workerAlreadyReported,
  workerDiffStat,
} from "./worker-report.ts";

/** Replay worker reports missing from the log after a crash. */
export async function rebuildMissingWorkerReports(input: {
  store: EventStore;
  git: GitService;
}): Promise<PendingEvent[]> {
  const { store, git } = input;
  const model = store.model;
  const events: PendingEvent[] = [];
  const seen = new Set<string>();

  for (const event of store.eventsAfter(0)) {
    if (event.type !== "turn.finished") continue;
    const thread = model.threads[event.threadId];
    if (!thread || !shouldReportWorker(thread, event.status)) continue;
    const key = `${event.threadId}\u0000${event.turnId}`;
    if (seen.has(key) || workerAlreadyReported(store, event.threadId, event.turnId)) continue;
    seen.add(key);
    const parentId = thread.parentThreadId;
    if (!parentId) continue;
    const project = model.projects[thread.projectId];
    const summary = turnSummary(model, event.threadId, event.turnId, event.status, event.error);
    let diffStat: Awaited<ReturnType<typeof workerDiffStat>> = undefined;
    if (thread.worktree && project) {
      try {
        await git.commitWorktreeChanges(project.root, thread.worktree, `Wooky: ${thread.title}`);
      } catch {
        // Best effort before diff stat.
      }
      diffStat = await workerDiffStat(git, project.root, thread.worktree.branch);
    }
    events.push(
      ...buildWorkerReportEvents({
        coordinatorThreadId: parentId,
        worker: thread,
        turnId: event.turnId,
        summary,
        diffStat,
      }),
    );
  }

  return events;
}
