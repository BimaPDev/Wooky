import { randomUUID } from "node:crypto";
import type {
  AgeEventOf,
  AgentResult,
  Command,
  MergePreview,
  RpcParams,
  RpcResult,
  ThreadSpawnParams,
} from "@wooky/contracts";
import { childrenOf, fleetRows } from "@wooky/domain";
import type { Dispatcher } from "../orchestrator/dispatcher.ts";
import { ServiceError } from "../errors.ts";
import type { GitService } from "../git/types.ts";
import type { EventStore } from "../store/event-store.ts";
import { resolveAgentCaller, verifyAgentToken } from "./agent-auth.ts";
import type { AgentTokenService } from "./agent-token.ts";
import { waitForAgentThreads } from "./agents-wait.ts";

type AgentsSpawnParams = RpcParams<"agents.spawn">;
type AgentsListParams = RpcParams<"agents.list">;
type AgentsWaitParams = RpcParams<"agents.wait">;
type AgentsResultParams = RpcParams<"agents.result">;

export interface FleetRpcContext {
  remoteAddress: string | undefined;
  signal: AbortSignal;
  reserveWait(): void;
  releaseWait(): void;
}

export interface FleetService {
  overview(): RpcResult<"fleet.overview">;
  mergePreview(params: RpcParams<"git.mergePreview">): Promise<MergePreview>;
  spawn(params: AgentsSpawnParams, ctx: FleetRpcContext): RpcResult<"agents.spawn">;
  list(params: AgentsListParams, ctx: FleetRpcContext): RpcResult<"agents.list">;
  wait(params: AgentsWaitParams, ctx: FleetRpcContext): Promise<RpcResult<"agents.wait">>;
  result(params: AgentsResultParams, ctx: FleetRpcContext): AgentResult;
}

export function createFleetService(deps: {
  store: EventStore;
  dispatcher: Dispatcher;
  git: GitService;
  tokens: AgentTokenService;
}): FleetService {
  const { store, dispatcher, git, tokens } = deps;

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
        await git.commitWorktreeChanges(project.root, thread.worktree, `AGE: ${thread.title}`);
        return await git.mergePreview(project.root, thread.worktree, `AGE: ${thread.title}`);
      } catch (error) {
        throw new ServiceError(
          "unavailable",
          error instanceof Error ? error.message : "Merge preview is not available.",
        );
      }
    },

    spawn(params, ctx) {
      const parentThreadId = resolveAgentCaller({
        model: store.model,
        remoteAddress: ctx.remoteAddress,
        agentToken: params.agentToken,
        parentThreadId: params.parentThreadId,
        tokens,
      });
      const { agentToken: _token, idempotencyKey, ...spawnFields } = params;
      const command: Command = {
        type: "thread.spawn",
        commandId: idempotencyKey ? `agents.spawn:${idempotencyKey}` : `agents:${randomUUID()}`,
        ...(spawnFields as ThreadSpawnParams),
        parentThreadId,
      };
      const before = store.model.seq;
      dispatcher.dispatch(command);
      const spawned = store
        .eventsAfter(before)
        .find((event): event is AgeEventOf<"thread.spawned"> => event.type === "thread.spawned");
      if (!spawned) throw new ServiceError("internal", "Spawn did not return a worker thread.");
      return { threadId: spawned.thread.id };
    },

    list(params, ctx) {
      const parentThreadId = resolveAgentCaller({
        model: store.model,
        remoteAddress: ctx.remoteAddress,
        agentToken: params.agentToken,
        parentThreadId: params.parentThreadId,
        tokens,
      });
      const parent = store.model.threads[parentThreadId];
      if (!parent) throw new ServiceError("not_found", `No thread with id ${parentThreadId}.`);
      const childIds = new Set(childrenOf(store.model, parentThreadId).map((thread) => thread.id));
      return [...fleetRows(store.model).filter((row) => childIds.has(row.threadId))];
    },

    wait(params, ctx) {
      verifyAgentToken({
        model: store.model,
        remoteAddress: ctx.remoteAddress,
        agentToken: params.agentToken,
        tokens,
      });
      for (const threadId of params.threadIds) {
        if (!store.model.threads[threadId]) {
          throw new ServiceError("not_found", `No thread with id ${threadId}.`);
        }
      }
      ctx.reserveWait();
      return waitForAgentThreads(store, params.threadIds, params.timeoutMs, ctx.signal).finally(
        () => ctx.releaseWait(),
      );
    },

    result(params, ctx) {
      verifyAgentToken({
        model: store.model,
        remoteAddress: ctx.remoteAddress,
        agentToken: params.agentToken,
        tokens,
      });
      const thread = store.model.threads[params.threadId];
      if (!thread) throw new ServiceError("not_found", `No thread with id ${params.threadId}.`);
      const row = fleetRows(store.model).find(
        (candidate) => candidate.threadId === params.threadId,
      );
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
