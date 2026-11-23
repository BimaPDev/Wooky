import {
  parseBrainUri,
  type BrainScope,
  type MemoryFrontmatterInput,
  type ReadModel,
  type RpcParams,
  type RpcResult,
} from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import type { AgentTokenService } from "../fleet/agent-token.ts";
import { createRunStore, fleetRunId, type RunCoordination } from "./claims.ts";
import { createBrainInbox, type BrainInbox } from "./inbox.ts";
import type { BrainLog } from "./paths.ts";
import type { BrainStore } from "./store.ts";
import { sanitizeAgentFrontmatter } from "./trust.ts";

const DEFAULT_SEARCH_LIMIT = 20;

type BrainCaller =
  { kind: "user" } | { kind: "agent"; threadId: string; projectId: string; agent: string };

export interface BrainServiceDeps {
  home: string;
  brainStore: BrainStore;
  inbox?: BrainInbox;
  runs?: RunCoordination;
  eventStore: { readonly model: ReadModel };
  tokens: AgentTokenService;
  clock?: () => string;
  log?: BrainLog;
}

export interface BrainService {
  list(params: RpcParams<"brain.list">): RpcResult<"brain.list">;
  read(params: RpcParams<"brain.read">): RpcResult<"brain.read">;
  search(params: RpcParams<"brain.search">): RpcResult<"brain.search">;
  write(params: RpcParams<"brain.write">): RpcResult<"brain.write">;
  archive(params: RpcParams<"brain.archive">): RpcResult<"brain.archive">;
  remove(params: RpcParams<"brain.remove">): RpcResult<"brain.remove">;
  reindex(params: RpcParams<"brain.reindex">): RpcResult<"brain.reindex">;
  inboxList(params: RpcParams<"brain.inbox.list">): RpcResult<"brain.inbox.list">;
  inboxApprove(params: RpcParams<"brain.inbox.approve">): RpcResult<"brain.inbox.approve">;
  inboxReject(params: RpcParams<"brain.inbox.reject">): RpcResult<"brain.inbox.reject">;
  claim(params: RpcParams<"brain.claim">): RpcResult<"brain.claim">;
  release(params: RpcParams<"brain.release">): RpcResult<"brain.release">;
  handoff(params: RpcParams<"brain.handoff">): RpcResult<"brain.handoff">;
  finding(params: RpcParams<"brain.finding">): RpcResult<"brain.finding">;
  close(): void;
}

function parseUriOrThrow(uri: string) {
  const parsed = parseBrainUri(uri);
  if (parsed === null) {
    throw new ServiceError(
      "bad_request",
      "Not a valid brain URI. Use brain://global/<path> or brain://project/<id>/<path>.",
    );
  }
  return parsed;
}

function assertReadableScope(caller: BrainCaller, scope: BrainScope): void {
  if (caller.kind !== "agent") return;
  if (scope.kind === "project" && scope.projectId !== caller.projectId) {
    throw new ServiceError(
      "forbidden",
      `Agent for project ${caller.projectId} may not access project ${scope.projectId}.`,
    );
  }
}

function assertWritableProjectScope(caller: BrainCaller, scope: BrainScope): void {
  if (caller.kind !== "agent") return;
  if (scope.kind !== "project" || scope.projectId !== caller.projectId) {
    throw new ServiceError(
      "forbidden",
      `Agent for project ${caller.projectId} may only modify memories in its own project.`,
    );
  }
}

function requireUser(caller: BrainCaller, message: string): void {
  if (caller.kind === "agent") throw new ServiceError("forbidden", message);
}

export function createBrainService(deps: BrainServiceDeps): BrainService {
  const { home, brainStore, eventStore, tokens } = deps;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const log: BrainLog = deps.log ?? (() => {});
  const inbox = deps.inbox ?? createBrainInbox({ home, store: brainStore, clock, log });
  const ownsRuns = deps.runs === undefined;
  const runs = deps.runs ?? createRunStore({ home, log });

  function resolveCaller(agentToken: string | undefined): BrainCaller {
    if (agentToken === undefined) return { kind: "user" };
    const threadId = tokens.verify(agentToken, eventStore.model);
    if (!threadId) throw new ServiceError("forbidden", "Invalid agent token.");
    const thread = eventStore.model.threads[threadId];
    if (!thread) throw new ServiceError("forbidden", "Invalid agent token.");
    return {
      kind: "agent",
      threadId: thread.id,
      projectId: thread.projectId,
      agent: thread.provider,
    };
  }

  function requireFleetAgent(agentToken: string | undefined) {
    if (agentToken === undefined) {
      throw new ServiceError("forbidden", "An agent token is required for fleet-run coordination.");
    }
    const caller = resolveCaller(agentToken);
    if (caller.kind !== "agent") {
      throw new ServiceError("forbidden", "An agent token is required for fleet-run coordination.");
    }
    const thread = eventStore.model.threads[caller.threadId];
    if (!thread) throw new ServiceError("forbidden", "Invalid agent token.");
    const runId = fleetRunId(thread);
    if (runId === null) {
      throw new ServiceError("bad_request", "Claims are for fleet runs.");
    }
    return { ...caller, runId };
  }

  return {
    list(params) {
      const caller = resolveCaller(params.agentToken);
      const parsed = parseUriOrThrow(params.uri);
      assertReadableScope(caller, parsed.scope);
      return brainStore.list(
        params.uri,
        params.includeArchived === undefined ? {} : { includeArchived: params.includeArchived },
      );
    },

    read(params) {
      const caller = resolveCaller(params.agentToken);
      const parsed = parseUriOrThrow(params.uri);
      assertReadableScope(caller, parsed.scope);
      return brainStore.read(params.uri, params.tier);
    },

    search(params) {
      const caller = resolveCaller(params.agentToken);
      for (const scope of params.scopes) assertReadableScope(caller, scope);
      return brainStore.search(params.query, {
        scopes: params.scopes,
        limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
        ...(params.pathPrefix === undefined ? {} : { pathPrefix: params.pathPrefix }),
        ...(params.includeArchived === undefined
          ? {}
          : { includeArchived: params.includeArchived }),
      });
    },

    write(params) {
      const caller = resolveCaller(params.agentToken);
      const parsed = parseUriOrThrow(params.uri);
      const writeOptions =
        params.expectedUpdatedAt === undefined
          ? {}
          : { expectedUpdatedAt: params.expectedUpdatedAt };

      // `propose` only ever lowers privilege: a caller without a token (a host that did not pass
      // the environment on) asks for the inbox and gets it. Nothing here lets a flag skip it.
      if (parsed.scope.kind === "global" && (caller.kind === "agent" || params.propose === true)) {
        const source =
          caller.kind === "agent"
            ? { threadId: caller.threadId, agent: caller.agent, at: clock() }
            : { agent: "mcp", at: clock() };
        const proposal = inbox.propose(params.uri, {
          frontmatter: { ...sanitizeAgentFrontmatter(params.frontmatter), source },
          body: params.body,
        });
        return {
          uri: proposal.targetUri,
          updatedAt: proposal.createdAt,
          created: false,
          queued: true,
          proposalId: proposal.id,
          message: "Queued in the brain inbox for user approval.",
        };
      }

      if (caller.kind === "agent") {
        assertWritableProjectScope(caller, parsed.scope);
        const stamped = {
          ...sanitizeAgentFrontmatter(params.frontmatter),
          source: { threadId: caller.threadId, agent: caller.agent, at: clock() },
        };
        const written = brainStore.write(
          params.uri,
          { frontmatter: stamped as MemoryFrontmatterInput, body: params.body },
          writeOptions,
        );
        return { ...written, queued: false };
      }

      const written = brainStore.write(
        params.uri,
        { frontmatter: params.frontmatter as MemoryFrontmatterInput, body: params.body },
        writeOptions,
      );
      return { ...written, queued: false };
    },

    archive(params) {
      const caller = resolveCaller(params.agentToken);
      const parsed = parseUriOrThrow(params.uri);
      assertWritableProjectScope(caller, parsed.scope);
      return brainStore.archive(params.uri);
    },

    remove(params) {
      const caller = resolveCaller(params.agentToken);
      const parsed = parseUriOrThrow(params.uri);
      assertWritableProjectScope(caller, parsed.scope);
      brainStore.remove(params.uri);
      return { ok: true as const };
    },

    reindex(params) {
      const caller = resolveCaller(params.agentToken);
      requireUser(caller, "Agents may not reindex the brain.");
      if (params.scope !== undefined) {
        const report = brainStore.reindex(params.scope);
        return { ...report, scopes: 1 };
      }
      let added = 0;
      let updated = 0;
      let removed = 0;
      let unchanged = 0;
      let scopes = 0;
      let truncated = false;
      const targets: BrainScope[] = [
        { kind: "global" },
        ...Object.keys(eventStore.model.projects).map((projectId): BrainScope => ({
          kind: "project",
          projectId,
        })),
      ];
      for (const scope of targets) {
        try {
          const report = brainStore.reindex(scope);
          added += report.added;
          updated += report.updated;
          removed += report.removed;
          unchanged += report.unchanged;
          scopes += 1;
          if (report.truncated) truncated = true;
        } catch (error) {
          if (scope.kind === "global" || !(error instanceof ServiceError)) throw error;
          log(`brain: skipping project ${scope.projectId} during reindex (${error.message})`);
        }
      }
      return {
        added,
        updated,
        removed,
        unchanged,
        scopes,
        ...(truncated ? { truncated: true } : {}),
      };
    },

    inboxList(params) {
      const caller = resolveCaller(params.agentToken);
      requireUser(caller, "Agents may not access the brain inbox.");
      return inbox.list();
    },

    inboxApprove(params) {
      const caller = resolveCaller(params.agentToken);
      requireUser(caller, "Agents may not approve brain proposals.");
      return inbox.approve(params.id, params.edits);
    },

    inboxReject(params) {
      const caller = resolveCaller(params.agentToken);
      requireUser(caller, "Agents may not reject brain proposals.");
      return inbox.reject(params.id);
    },

    claim(params) {
      const actor = requireFleetAgent(params.agentToken);
      const outcome = runs.claim({
        runId: actor.runId,
        projectId: actor.projectId,
        threadId: actor.threadId,
        agent: actor.agent,
        target: params.target,
        ...(params.note === undefined ? {} : { note: params.note }),
      });
      if (outcome.status === "claimed") {
        return {
          status: "claimed" as const,
          claimId: outcome.claim.id,
          expiresAt: outcome.claim.expiresAt,
        };
      }
      return {
        status: "held" as const,
        holder: {
          threadId: outcome.holder.threadId,
          agent: outcome.holder.agent,
          target: outcome.holder.target,
          note: outcome.holder.note,
          expiresAt: outcome.holder.expiresAt,
        },
      };
    },

    release(params) {
      const actor = requireFleetAgent(params.agentToken);
      const live = runs.list(actor.runId).claims.find((claim) => claim.id === params.claimId);
      if (live !== undefined && live.threadId !== actor.threadId) {
        throw new ServiceError(
          "forbidden",
          "Only the thread that holds this claim can release it.",
        );
      }
      return { released: runs.release(params.claimId, actor.threadId) };
    },

    handoff(params) {
      const actor = requireFleetAgent(params.agentToken);
      if (params.toThreadId !== undefined) {
        const target = eventStore.model.threads[params.toThreadId];
        if (!target || fleetRunId(target) !== actor.runId) {
          throw new ServiceError("bad_request", "toThreadId must belong to the same fleet run.");
        }
      }
      const created = runs.handoff({
        runId: actor.runId,
        fromThreadId: actor.threadId,
        ...(params.toThreadId === undefined ? {} : { toThreadId: params.toThreadId }),
        summary: params.summary,
      });
      return { handoffId: created.id };
    },

    finding(params) {
      const actor = requireFleetAgent(params.agentToken);
      const created = runs.findings({
        runId: actor.runId,
        threadId: actor.threadId,
        text: params.text,
      });
      return { findingId: created.id };
    },

    close() {
      if (ownsRuns) runs.close();
      brainStore.close();
    },
  };
}
