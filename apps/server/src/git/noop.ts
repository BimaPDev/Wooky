import type { MergePreview, MergeStrategy, Worktree } from "@age/contracts";
import type { GitService, MergeWorktreeResult } from "./types.ts";

/** Stand-in until the real git service is wired: every workspace looks like a non-repo. */
export function createNoopGitService(): GitService {
  const unavailable = (what: string) => () =>
    Promise.reject(new Error(`Git support is not available yet (${what}).`));
  const emptyPreview = (): Promise<MergePreview> =>
    Promise.resolve({ targetBranch: "main", ahead: 0, behind: 0, files: [], conflicts: [] });
  const mergeFail = (): Promise<MergeWorktreeResult> =>
    Promise.resolve({ ok: false, kind: "failed", message: "Git support is not available." });
  return {
    isRepo: async () => false,
    createWorktree: unavailable("create worktree"),
    removeWorktree: unavailable("remove worktree"),
    captureCheckpoint: unavailable("capture checkpoint"),
    restoreCheckpoint: unavailable("restore checkpoint"),
    diff: unavailable("diff"),
    listFiles: unavailable("list files"),
    diffBranchStat: async () => null,
    mergePreview: emptyPreview,
    mergeWorktree: async (_projectRoot: string, _worktree: Worktree, _strategy: MergeStrategy) =>
      mergeFail(),
  };
}
