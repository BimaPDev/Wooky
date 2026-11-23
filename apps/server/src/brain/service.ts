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
import { createBrainInbox } from "./inbox.ts";
import type { BrainLog } from "./paths.ts";
import type { BrainStore } from "./store.ts";

const DEFAULT_SEARCH_LIMIT = 20;

type BrainCaller =
  { kind: "user" } | { kind: "agent"; threadId: string; projectId: string; agent: string };

export interface BrainServiceDeps {
  home: string;
  brainStore: BrainStore;
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
  const inbox = createBrainInbox({ home, store: brainStore, clock, log });

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
      if (caller.kind === "agent") {
        const stampedFrontmatter = {
          ...params.frontmatter,
          source: {
            threadId: caller.threadId,
            agent: caller.agent,
            at: clock(),
          },
        };
        if (parsed.scope.kind === "global") {
          const proposal = inbox.propose(params.uri, {
            frontmatter: stampedFrontmatter,
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
        assertWritableProjectScope(caller, parsed.scope);
        const written = brainStore.write(
          params.uri,
          { frontmatter: stampedFrontmatter as MemoryFrontmatterInput, body: params.body },
          params.expectedUpdatedAt === undefined
            ? {}
            : { expectedUpdatedAt: params.expectedUpdatedAt },
        );
        return { ...written, queued: false };
      }

      const written = brainStore.write(
        params.uri,
        { frontmatter: params.frontmatter as MemoryFrontmatterInput, body: params.body },
        params.expectedUpdatedAt === undefined
          ? {}
          : { expectedUpdatedAt: params.expectedUpdatedAt },
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
      return inbox.approve(params.id);
    },

    inboxReject(params) {
      const caller = resolveCaller(params.agentToken);
      requireUser(caller, "Agents may not reject brain proposals.");
      return inbox.reject(params.id);
    },

    close() {
      brainStore.close();
    },
  };
}
