import type { DiffStat, MergePreview, MergeStrategy, Worktree } from "@age/contracts";
import type { MergeWorktreeResult } from "./types.ts";

type Run = (
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; allowFail?: boolean },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

interface MergeOpsDeps {
  run: Run;
  topLevel: (cwd: string) => Promise<string>;
  withRepoLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  lockKey: (cwd: string) => Promise<string>;
  baseEnv: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

const AGE_IDENTITY = {
  GIT_AUTHOR_NAME: "Wooky",
  GIT_AUTHOR_EMAIL: "age@localhost",
  GIT_COMMITTER_NAME: "Wooky",
  GIT_COMMITTER_EMAIL: "age@localhost",
} as const;

export function createMergeOps(deps: MergeOpsDeps) {
  const { run, topLevel, withRepoLock, lockKey, baseEnv } = deps;

  async function currentBranch(cwd: string): Promise<string> {
    const short = await run(["symbolic-ref", "--short", "HEAD"], { cwd, allowFail: true });
    if (short.code === 0 && short.stdout.trim()) return short.stdout.trim();
    const head = await run(["rev-parse", "--short", "HEAD"], { cwd });
    return head.stdout.trim();
  }

  async function isDirty(cwd: string): Promise<boolean> {
    const { stdout } = await run(["status", "--porcelain"], { cwd });
    return stdout.trim().length > 0;
  }

  async function conflictPaths(cwd: string): Promise<string[]> {
    const { stdout } = await run(["diff", "--name-only", "--diff-filter=U"], {
      cwd,
      allowFail: true,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async function diffBranchStat(projectRoot: string, branch: string): Promise<DiffStat | null> {
    const top = await topLevel(projectRoot);
    const rev = await run(["rev-parse", "--verify", branch], { cwd: top, allowFail: true });
    if (rev.code !== 0) return null;
    const { stdout } = await run(["diff", "--numstat", `HEAD...${branch}`], {
      cwd: top,
      allowFail: true,
    });
    if (!stdout.trim()) return null;
    let files = 0;
    let additions = 0;
    let deletions = 0;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [add, del] = line.split("\t");
      if (!add || !del) continue;
      files += 1;
      if (add !== "-") additions += Number.parseInt(add, 10) || 0;
      if (del !== "-") deletions += Number.parseInt(del, 10) || 0;
    }
    return files > 0 ? { files, additions, deletions } : null;
  }

  async function mergePreview(projectRoot: string, worktree: Worktree): Promise<MergePreview> {
    const top = await topLevel(projectRoot);
    const targetBranch = await currentBranch(top);
    const counts = await run(["rev-list", "--left-right", "--count", `HEAD...${worktree.branch}`], {
      cwd: top,
      allowFail: true,
    });
    let behind = 0;
    let ahead = 0;
    if (counts.code === 0) {
      const [left, right] = counts.stdout.trim().split(/\s+/);
      behind = Number.parseInt(left ?? "0", 10) || 0;
      ahead = Number.parseInt(right ?? "0", 10) || 0;
    }

    const numstat = await run(["diff", "--numstat", `HEAD...${worktree.branch}`], {
      cwd: top,
      allowFail: true,
    });
    const files: MergePreview["files"] = [];
    for (const line of numstat.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const add = parts[0] ?? "0";
      const del = parts[1] ?? "0";
      const path = parts.slice(2).join("\t");
      files.push({
        path,
        additions: add === "-" ? 0 : Number.parseInt(add, 10) || 0,
        deletions: del === "-" ? 0 : Number.parseInt(del, 10) || 0,
      });
    }

    const conflicts = await detectConflicts(top, worktree.branch);
    return { targetBranch, ahead, behind, files, conflicts };
  }

  async function detectConflicts(top: string, branch: string): Promise<string[]> {
    const baseRes = await run(["merge-base", "HEAD", branch], { cwd: top, allowFail: true });
    if (baseRes.code !== 0) return [];
    const base = baseRes.stdout.trim();
    const treeRes = await run(["merge-tree", "--write-tree", base, "HEAD", branch], {
      cwd: top,
      allowFail: true,
    });
    if (treeRes.code !== 0) return [];
    const paths = new Set<string>();
    for (const line of treeRes.stdout.split("\n")) {
      const match = line.match(/CONFLICT.*?\s+(\S+)/);
      if (match?.[1]) paths.add(match[1]);
    }
    return [...paths];
  }

  async function mergeWorktree(
    projectRoot: string,
    worktree: Worktree,
    strategy: MergeStrategy,
    title: string,
    message?: string,
  ): Promise<MergeWorktreeResult> {
    const top = await topLevel(projectRoot);
    const key = await lockKey(top);
    return withRepoLock(key, async () => {
      if (await isDirty(top)) {
        return {
          ok: false,
          kind: "dirty",
          message: "The project has uncommitted changes. Commit or stash them before merging.",
        };
      }
      const targetBranch = await currentBranch(top);
      const mergeArgs =
        strategy === "merge"
          ? ["merge", "--no-ff", "--no-edit", worktree.branch]
          : ["merge", "--squash", worktree.branch];
      const merged = await run(mergeArgs, { cwd: top, allowFail: true });
      if (merged.code !== 0) {
        const paths = await conflictPaths(top);
        await run(["merge", "--abort"], { cwd: top, allowFail: true });
        if (paths.length > 0) {
          return {
            ok: false,
            kind: "conflict",
            message: `Merge conflict in ${paths.join(", ")}.`,
            conflicts: paths,
            targetBranch,
          };
        }
        const detail = (merged.stderr || merged.stdout).trim() || "Merge failed.";
        return { ok: false, kind: "failed", message: detail, targetBranch };
      }

      if (strategy === "squash") {
        const commitMsg = message?.trim() || `Merge ${title}`;
        const commit = await run(["commit", "-m", commitMsg], {
          cwd: top,
          env: baseEnv(AGE_IDENTITY),
          allowFail: true,
        });
        if (commit.code !== 0) {
          await run(["reset", "--hard", "HEAD"], { cwd: top, allowFail: true });
          return {
            ok: false,
            kind: "failed",
            message: commit.stderr.trim() || "Could not create the squash commit.",
            targetBranch,
          };
        }
      }

      const sha = (await run(["rev-parse", "HEAD"], { cwd: top })).stdout.trim();
      return { ok: true, commit: sha, targetBranch };
    });
  }

  return { diffBranchStat, mergePreview, mergeWorktree };
}
