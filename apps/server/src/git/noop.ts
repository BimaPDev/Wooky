import type { GitService } from "./types.ts";

/** Stand-in until the real git service is wired: every workspace looks like a non-repo. */
export function createNoopGitService(): GitService {
  const unavailable = (what: string) => () =>
    Promise.reject(new Error(`Git support is not available yet (${what}).`));
  return {
    isRepo: async () => false,
    createWorktree: unavailable("create worktree"),
    removeWorktree: unavailable("remove worktree"),
    captureCheckpoint: unavailable("capture checkpoint"),
    restoreCheckpoint: unavailable("restore checkpoint"),
    diff: unavailable("diff"),
  };
}
