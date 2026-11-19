import { randomUUID } from "node:crypto";
import type {
  AgeEventOf,
  AgentResult,
  Command,
  MergePreview,
  RpcParams,
  RpcResult,
  ThreadSpawnParams,
} from "@age/contracts";
import { childrenOf, fleetRows } from "@age/domain";
import type { Dispatcher } from "../orchestrator/dispatcher.ts";
import { ServiceError } from "../errors.ts";
import type { GitService } from "../git/types.ts";
import type { EventStore } from "../store/event-store.ts";
import { waitForAgentThreads } from "./agents-wait.ts";

export interface FleetService {
  overview(): RpcResult<"fleet.overview">;
  mergePreview(params: RpcParams<"git.mergePreview">): Promise<MergePreview>;
  spawn(params: ThreadSpawnParams): RpcResult<"agents.spawn">;
  list(params: RpcParams<"agents.list">): RpcResult<"agents.list">;
  wait(params: RpcParams<"agents.wait">): Promise<RpcResult<"agents.wait">>;
  result(params: RpcParams<"agents.result">): AgentResult;
}

export function createFleetService(deps: {
  store: EventStore;
  dispatcher: Dispatcher;
  git: GitService;
}): FleetService {
  const { store, dispatcher, git } = deps;

  return {
    overview: () => [...fleetRows(store.model)],

    async mergePreview({ threadId }) {
      const thread = store.model.threads[threadId];
      if (!thread) throw new ServiceError("not_found", `No thread with id ${threadId}.`);
      if (!thread.worktree)
        throw new ServiceError("bad_request", "This thread has no worktree to preview.");
      const project = store.model.projects[thread.projectId];
      if (!project) throw new ServiceError("not_found", `No project with id ${thread.projectId}.`);
      try {
        return await git.mergePreview(project.root, thread.worktree);
      } catch (error) {
        throw new ServiceError(
          "unavailable",
          error instanceof Error ? error.message : "Merge preview is not available.",
        );
      }
    },

    spawn(params) {
      const command: Command = {
        type: "thread.spawn",
        commandId: `agents:${randomUUID()}`,
        ...params,
      };
      const before = store.model.seq;
      dispatcher.dispatch(command);
      const spawned = store
        .eventsAfter(before)
        .find((event): event is AgeEventOf<"thread.spawned"> => event.type === "thread.spawned");
      if (!spawned) throw new ServiceError("internal", "Spawn did not return a worker thread.");
      return { threadId: spawned.thread.id };
    },

    list({ parentThreadId }) {
      const parent = store.model.threads[parentThreadId];
      if (!parent) throw new ServiceError("not_found", `No thread with id ${parentThreadId}.`);
      const childIds = new Set(childrenOf(store.model, parentThreadId).map((thread) => thread.id));
      return [...fleetRows(store.model).filter((row) => childIds.has(row.threadId))];
    },

    wait(params) {
      return waitForAgentThreads(store, params.threadIds, params.timeoutMs);
    },

    result({ threadId }) {
      const thread = store.model.threads[threadId];
      if (!thread) throw new ServiceError("not_found", `No thread with id ${threadId}.`);
      const row = fleetRows(store.model).find((candidate) => candidate.threadId === threadId);
      const status = row?.status ?? "idle";
      return {
        status,
        summary: thread.report?.summary ?? "",
        ...(thread.report?.diffStat ? { diffStat: thread.report.diffStat } : {}),
        ...(thread.worktree?.path ? { worktreePath: thread.worktree.path } : {}),
      };
    },
  };
}
