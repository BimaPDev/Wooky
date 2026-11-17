import type { FileDiff, Worktree } from "@age/contracts";

/**
 * Git seam. Checkpoints are commits stored under hidden refs
 * (refs/age/checkpoints/<threadId>/<turnId>/{before,after}) built from a temporary
 * index, so the user's branches, index and stash are never touched.
 */
export interface GitService {
  isRepo(cwd: string): Promise<boolean>;
  /** Create `<root>/../.age-worktrees/<repo>/<threadId>` on branch `age/<threadId>`. */
  createWorktree(projectRoot: string, threadId: string): Promise<Worktree>;
  removeWorktree(projectRoot: string, worktree: Worktree): Promise<void>;
  /** Snapshot the working tree (tracked + untracked, respecting .gitignore). Returns the ref name. */
  captureCheckpoint(cwd: string, ref: string): Promise<string>;
  /** Restore the working tree to a checkpoint ref. */
  restoreCheckpoint(cwd: string, ref: string): Promise<void>;
  /** Diff between two refs, or between a ref and the live working tree when `to` is null. */
  diff(cwd: string, from: string, to: string | null): Promise<FileDiff[]>;
  /** Tracked and untracked files under cwd, relative, respecting .gitignore. */
  listFiles(cwd: string): Promise<string[]>;
}
