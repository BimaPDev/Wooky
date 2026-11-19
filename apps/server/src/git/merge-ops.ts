import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

const AGE_BRANCH = /^age\/[\w./-]+$/;
const MARKER_FILE = "age-merge-in-progress";
const LOCK_FILE = "age-merge.lock";
const UNPARSABLE_LOCK_STALE_MS = 60_000;
const MID_MERGE = "Project is mid-merge; run git merge --abort";
const MID_SQUASH = "Project has a half-applied squash merge; run git reset --merge";

/** Lock paths this process holds, so a live lock with our own pid is never mistaken for a stale one. */
const heldLocks = new Set<string>();

function isAgeBranch(branch: string): boolean {
  return (
    AGE_BRANCH.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock")
  );
}

/** Conflicted paths from `git merge-tree --write-tree --name-only -z`: oid, names, then an empty field. */
export function parseMergeTreeNames(stdout: string): string[] {
  const fields = stdout.split("\0");
  const names = new Set<string>();
  for (const field of fields.slice(1)) {
    if (field === "") break;
    names.add(field);
  }
  return [...names];
}

/** Conflicted paths from the pre-2.38 `git merge-tree <base> <a> <b>` text format. */
export function parseLegacyMergeTree(stdout: string): string[] {
  const paths = new Set<string>();
  let section: string[] = [];
  const flush = () => {
    if (!section.some((line) => line.startsWith("+<<<<<<<"))) return;
    for (const line of section) {
      const match = line.match(/^\s+(?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+)$/);
      if (match?.[1]) paths.add(match[1]);
    }
  };
  for (const line of stdout.split("\n")) {
    if (line.length > 0 && !/^[\s@+\-<=>]/.test(line)) {
      flush();
      section = [];
    }
    section.push(line);
  }
  flush();
  return [...paths];
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : undefined;
}

async function lockIsStale(path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return true;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      return Date.now() - (await stat(path)).mtimeMs > UNPARSABLE_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  if (pid === process.pid) return !heldLocks.has(path);
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return errorCode(cause) === "ESRCH";
  }
}

/** Exclusive-create lockfile holding our pid. Returns a release function, or null when another live process holds it. */
async function acquireFileLock(path: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      heldLocks.add(path);
      return async () => {
        heldLocks.delete(path);
        await rm(path, { force: true });
      };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      if (!(await lockIsStale(path))) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}

interface Marker {
  branch: string;
  strategy: MergeStrategy;
}

export function createMergeOps(deps: MergeOpsDeps) {
  const { run, topLevel, withRepoLock, lockKey, baseEnv } = deps;
  let writeTreeSupport: Promise<boolean> | undefined;

  async function symbolicBranch(cwd: string): Promise<string | null> {
    const res = await run(["symbolic-ref", "-q", "HEAD"], { cwd, allowFail: true });
    const ref = res.stdout.trim();
    if (res.code !== 0 || !ref) return null;
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  }

  async function currentBranch(cwd: string): Promise<string> {
    const branch = await symbolicBranch(cwd);
    if (branch) return branch;
    const head = await run(["rev-parse", "--short", "HEAD"], { cwd });
    return head.stdout.trim();
  }

  async function isDirty(cwd: string): Promise<boolean> {
    const { stdout } = await run(["status", "--porcelain"], { cwd });
    return stdout.trim().length > 0;
  }

  async function conflictPaths(cwd: string): Promise<string[]> {
    const { stdout } = await run(["diff", "--name-only", "--diff-filter=U", "-z"], {
      cwd,
      allowFail: true,
    });
    return stdout.split("\0").filter((line) => line.length > 0);
  }

  async function hasMergeHead(cwd: string): Promise<boolean> {
    const res = await run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd, allowFail: true });
    return res.code === 0;
  }

  async function hasStagedChanges(cwd: string): Promise<boolean> {
    const res = await run(["diff", "--cached", "--quiet"], { cwd, allowFail: true });
    return res.code !== 0;
  }

  async function gitDir(cwd: string): Promise<string> {
    const { stdout } = await run(["rev-parse", "--absolute-git-dir"], { cwd });
    return stdout.trim();
  }

  async function readMarker(path: string): Promise<Marker | null | "unreadable"> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      return errorCode(cause) === "ENOENT" ? null : "unreadable";
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "branch" in parsed &&
        "strategy" in parsed &&
        typeof parsed.branch === "string" &&
        (parsed.strategy === "merge" || parsed.strategy === "squash")
      ) {
        return { branch: parsed.branch, strategy: parsed.strategy };
      }
    } catch {
      // fall through
    }
    return "unreadable";
  }

  /**
   * Put the root back in the state it had before an AGE merge began. Only ever acts on state
   * AGE created (the marker proves it); a mid-merge root without the marker is the user's.
   * `reset --merge` keeps working-tree edits that differ from the index, so a user's own
   * unrelated edit survives; when it cannot proceed we say so rather than force it.
   */
  async function repairInterruptedMerge(
    top: string,
    dir: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const markerPath = join(dir, MARKER_FILE);
    const marker = await readMarker(markerPath);
    const mergeHead = await hasMergeHead(top);
    if (marker === null) {
      return mergeHead ? { ok: false, message: MID_MERGE } : { ok: true };
    }
    if (marker === "unreadable") {
      return {
        ok: false,
        message: mergeHead ? MID_MERGE : `${MID_MERGE} (unreadable ${MARKER_FILE})`,
      };
    }
    if (mergeHead) {
      const aborted = await run(["merge", "--abort"], { cwd: top, allowFail: true });
      if (aborted.code !== 0) {
        const detail = (aborted.stderr || aborted.stdout).trim();
        return { ok: false, message: detail ? `${MID_MERGE}. ${detail}` : MID_MERGE };
      }
    } else if (existsSync(join(dir, "SQUASH_MSG"))) {
      const undone = await undoSquash(top);
      if (!undone.ok) return undone;
    }
    if ((await hasMergeHead(top)) || (await conflictPaths(top)).length > 0) {
      return { ok: false, message: MID_MERGE };
    }
    await rm(markerPath, { force: true });
    return { ok: true };
  }

  /** Undo the index and tree changes `merge --squash` made, leaving the user's other edits alone. */
  async function undoSquash(top: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const reset = await run(["reset", "-q", "--merge"], { cwd: top, allowFail: true });
    if (reset.code === 0) return { ok: true };
    await run(["reset", "-q"], { cwd: top, allowFail: true });
    const detail = (reset.stderr || reset.stdout).trim();
    return { ok: false, message: detail ? `${MID_SQUASH}. ${detail}` : MID_SQUASH };
  }

  /** After a failed git step: abort or unstage what AGE started, then drop the marker only if the root is clean. */
  async function rollback(
    top: string,
    dir: string,
    strategy: MergeStrategy,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (await hasMergeHead(top)) {
      const aborted = await run(["merge", "--abort"], { cwd: top, allowFail: true });
      if (aborted.code !== 0) {
        const detail = (aborted.stderr || aborted.stdout).trim();
        return { ok: false, message: detail ? `${MID_MERGE}. ${detail}` : MID_MERGE };
      }
    } else if (
      strategy === "squash" &&
      (existsSync(join(dir, "SQUASH_MSG")) ||
        (await hasStagedChanges(top)) ||
        (await conflictPaths(top)).length > 0)
    ) {
      const undone = await undoSquash(top);
      if (!undone.ok) return undone;
    }
    await rm(join(dir, MARKER_FILE), { force: true });
    return { ok: true };
  }

  async function supportsWriteTree(top: string): Promise<boolean> {
    writeTreeSupport ??= run(["version"], { cwd: top, allowFail: true }).then((res) => {
      const match = res.stdout.match(/(\d+)\.(\d+)/);
      if (!match) return false;
      const major = Number.parseInt(match[1] ?? "0", 10);
      const minor = Number.parseInt(match[2] ?? "0", 10);
      return major > 2 || (major === 2 && minor >= 38);
    });
    return writeTreeSupport;
  }

  async function diffBranchStat(projectRoot: string, branch: string): Promise<DiffStat | null> {
    if (!isAgeBranch(branch)) return null;
    const top = await topLevel(projectRoot);
    const ref = `refs/heads/${branch}`;
    const rev = await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: top,
      allowFail: true,
    });
    if (rev.code !== 0) return null;
    const { stdout } = await run(["diff", "--numstat", `HEAD...${ref}`, "--"], {
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
    if (!isAgeBranch(worktree.branch)) {
      throw new Error(`Unexpected worktree branch: ${worktree.branch}`);
    }
    const top = await topLevel(projectRoot);
    const ref = `refs/heads/${worktree.branch}`;
    const targetBranch = await currentBranch(top);
    const counts = await run(["rev-list", "--left-right", "--count", `HEAD...${ref}`, "--"], {
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

    const numstat = await run(["diff", "--numstat", `HEAD...${ref}`, "--"], {
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

    const conflicts = await detectConflicts(top, ref);
    return { targetBranch, ahead, behind, files, conflicts };
  }

  async function detectConflicts(top: string, ref: string): Promise<string[]> {
    if (await supportsWriteTree(top)) {
      const res = await run(["merge-tree", "--write-tree", "--name-only", "-z", "HEAD", ref], {
        cwd: top,
        allowFail: true,
      });
      if (res.code !== 1) return [];
      return parseMergeTreeNames(res.stdout);
    }
    const baseRes = await run(["merge-base", "HEAD", ref], { cwd: top, allowFail: true });
    if (baseRes.code !== 0) return [];
    const res = await run(["merge-tree", baseRes.stdout.trim(), "HEAD", ref], {
      cwd: top,
      allowFail: true,
    });
    return res.code === 0 ? parseLegacyMergeTree(res.stdout) : [];
  }

  async function mergeWorktree(
    projectRoot: string,
    worktree: Worktree,
    strategy: MergeStrategy,
    title: string,
    message?: string,
  ): Promise<MergeWorktreeResult> {
    if (!isAgeBranch(worktree.branch)) {
      return {
        ok: false,
        kind: "failed",
        message: `Unexpected worktree branch: ${worktree.branch}`,
      };
    }
    const top = await topLevel(projectRoot);
    const key = await lockKey(top);
    return withRepoLock(key, async () => {
      const release = await acquireFileLock(join(key, LOCK_FILE));
      if (!release) {
        return {
          ok: false,
          kind: "failed",
          message: "Another merge is running in this project. Try again when it finishes.",
        };
      }
      try {
        return await mergeLocked(top, worktree.branch, strategy, title, message);
      } finally {
        await release();
      }
    });
  }

  async function mergeLocked(
    top: string,
    branch: string,
    strategy: MergeStrategy,
    title: string,
    message?: string,
  ): Promise<MergeWorktreeResult> {
    const dir = await gitDir(top);
    const targetBranch = (await symbolicBranch(top)) ?? undefined;
    const failed = (text: string): MergeWorktreeResult => ({
      ok: false,
      kind: "failed",
      message: text,
      ...(targetBranch ? { targetBranch } : {}),
    });

    const repaired = await repairInterruptedMerge(top, dir);
    if (!repaired.ok) return failed(repaired.message);
    if (!targetBranch) {
      return failed("Project is on a detached HEAD. Check out a branch before merging.");
    }
    if (await isDirty(top)) {
      return {
        ok: false,
        kind: "dirty",
        message: "The project has uncommitted changes. Commit or stash them before merging.",
        targetBranch,
      };
    }

    const ref = `refs/heads/${branch}`;
    const exists = await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: top,
      allowFail: true,
    });
    if (exists.code !== 0) return failed(`Branch ${branch} does not exist.`);
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      cwd: top,
      allowFail: true,
    });
    if (head.code !== 0) return failed("Project has no commits yet.");
    const headSha = head.stdout.trim();

    const ancestor = await run(["merge-base", "--is-ancestor", ref, "HEAD"], {
      cwd: top,
      allowFail: true,
    });
    if (ancestor.code === 0) return { ok: true, commit: headSha, targetBranch };

    const markerPath = join(dir, MARKER_FILE);
    const marker: Marker = { branch, strategy };
    await writeFile(markerPath, JSON.stringify(marker));

    const commitMessage = message?.trim() || (strategy === "squash" ? `Merge ${title}` : "");
    const mergeArgs =
      strategy === "merge"
        ? [
            "merge",
            "--no-ff",
            ...(commitMessage ? ["-m", commitMessage] : ["--no-edit"]),
            "--",
            ref,
          ]
        : ["merge", "--squash", "--", ref];
    const merged = await run(mergeArgs, { cwd: top, allowFail: true });
    if (merged.code !== 0) {
      const paths = await conflictPaths(top);
      const detail = [merged.stderr, merged.stdout].join("\n").trim() || "Merge failed.";
      const rolled = await rollback(top, dir, strategy);
      if (!rolled.ok) return failed(rolled.message);
      if (paths.length > 0) {
        return {
          ok: false,
          kind: "conflict",
          message: `Merge conflict in ${paths.join(", ")}.`,
          conflicts: paths,
          targetBranch,
        };
      }
      return failed(detail);
    }

    if (strategy === "squash") {
      if (!(await hasStagedChanges(top))) {
        await run(["reset", "-q"], { cwd: top, allowFail: true });
        await rm(markerPath, { force: true });
        const sha = (await run(["rev-parse", "HEAD"], { cwd: top })).stdout.trim();
        return { ok: true, commit: sha, targetBranch };
      }
      const commit = await run(["commit", "-m", commitMessage], {
        cwd: top,
        env: baseEnv(AGE_IDENTITY),
        allowFail: true,
      });
      if (commit.code !== 0) {
        const detail =
          [commit.stderr, commit.stdout].join("\n").trim() || "Could not create the squash commit.";
        const rolled = await rollback(top, dir, strategy);
        return failed(rolled.ok ? detail : `${detail}\n${rolled.message}`);
      }
    }

    await rm(markerPath, { force: true });
    const sha = (await run(["rev-parse", "HEAD"], { cwd: top })).stdout.trim();
    return { ok: true, commit: sha, targetBranch };
  }

  return { diffBranchStat, mergePreview, mergeWorktree };
}
