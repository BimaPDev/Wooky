import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FileDiff, RpcParams, RpcResult } from "@wooky/contracts";
import { ServiceError } from "./errors.ts";
import type { GitService } from "./git/types.ts";
import type { EventStore } from "./store/event-store.ts";
import { createWorkspaceSearch } from "./workspace/search.ts";

const PICKABLE_MAX = 50;

export interface Queries {
  diff(threadId: string, turnId?: string): Promise<FileDiff[]>;
  pickable(query?: string): RpcResult<"fs.pickable">;
  searchEntries(params: RpcParams<"fs.searchEntries">): Promise<RpcResult<"fs.searchEntries">>;
}

/** Read-only questions about the workspace that the read model alone cannot answer. */
export function createQueries(deps: {
  store: EventStore;
  git: GitService;
  userHome: string;
}): Queries {
  const { store, git, userHome } = deps;
  const workspace = createWorkspaceSearch({
    model: () => store.model,
    listFiles: (cwd) => git.listFiles(cwd),
  });
  return {
    searchEntries: (params) => workspace.search(params),

    async diff(threadId, turnId) {
      const model = store.model;
      const thread = model.threads[threadId];
      if (!thread) throw new ServiceError("not_found", `No thread with id ${threadId}.`);
      const cwd = thread.worktree?.path ?? model.projects[thread.projectId]?.root;
      if (!cwd) throw new ServiceError("not_found", `No project with id ${thread.projectId}.`);
      const turns = model.turns[threadId] ?? [];

      let from: string | null;
      let to: string | null = null;
      if (turnId === undefined) {
        from = turns[0]?.checkpointBefore ?? null;
      } else {
        const turn = turns.find((candidate) => candidate.id === turnId);
        if (!turn) throw new ServiceError("not_found", `No turn with id ${turnId}.`);
        from = turn.checkpointBefore;
        if (turn.status !== "running") {
          if (!turn.checkpointAfter) return [];
          to = turn.checkpointAfter;
        }
      }
      if (!from || !(await git.isRepo(cwd))) return [];
      try {
        return await git.diff(cwd, from, to);
      } catch (error) {
        throw new ServiceError(
          "unavailable",
          `Diff is not available: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    pickable(query) {
      const needle = query?.trim().toLowerCase() ?? "";
      const roots = Object.values(store.model.projects).map((project) => project.root);
      const paths = new Set([
        ...roots.filter((root) => existsSync(root)),
        ...homeChildren(userHome),
      ]);
      return [...paths]
        .filter((path) => path.toLowerCase().includes(needle))
        .slice(0, PICKABLE_MAX)
        .map((path) => ({ path, isGitRepo: existsSync(join(path, ".git")) }));
    },
  };
}

function homeChildren(home: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(home, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
