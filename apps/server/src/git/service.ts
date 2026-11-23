/**
 * Git service. Checkpoints are commits stored under hidden refs, built from a throwaway
 * temp index, so the user's branches, index and stash are never touched — with one
 * documented exception: restoreCheckpoint drops the exact paths it just deleted from the
 * REAL index via `git rm --cached --ignore-unmatch` (argv-only, pathspecs read from stdin
 * NUL-delimited), so a later `git commit` cannot record a file the restore removed. That
 * step only ever removes entries for paths restore itself deleted; it never alters entries
 * for other files and never touches HEAD, branches or the stash.
 * User commit, push and pull requests are implemented in ship.ts.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, rmdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { FileDiff, Worktree } from "@wooky/contracts";
import { commitWorktreeChanges as commitWorktreeImpl } from "./commit-worktree.ts";
import { gitChildEnv } from "./env.ts";
import { createMergeOps } from "./merge-ops.ts";
import type { GitService } from "./types.ts";

/** Error raised when a git invocation exits non-zero. Carries the full argv and trimmed stderr. */
export class GitError extends Error {
  readonly argv: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(argv: string[], code: number | null, stderr: string) {
    super(`git ${argv.join(" ")} failed (exit ${code ?? "?"}): ${stderr}`);
    this.name = "GitError";
    this.argv = argv;
    this.code = code;
    this.stderr = stderr;
  }
}

const WOOKY_IDENTITY = {
  GIT_AUTHOR_NAME: "Wooky",
  GIT_AUTHOR_EMAIL: "wooky@localhost",
  GIT_COMMITTER_NAME: "Wooky",
  GIT_COMMITTER_EMAIL: "wooky@localhost",
} as const;

const PATCH_LIMIT = 200 * 1024;
const TRUNCATION_NOTICE = "\n… diff truncated\n";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_STDOUT_CAP = 64 * 1024 * 1024;

/** New checkpoints use refs/wooky/. refs/age/ remains valid so stored events can still restore. */
const WOOKY_REF = /^refs\/(?:wooky|age)\/[A-Za-z0-9._/-]+$/;

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
  input?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function createGitService(options?: {
  gitBin?: string;
  /** Args placed before every git argument; tests run a node script as `git` with it. */
  gitPrefixArgs?: readonly string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  listFilesCap?: number;
}): GitService {
  const gitBin = options?.gitBin ?? "git";
  const gitPrefixArgs = options?.gitPrefixArgs ?? [];
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options?.maxStdoutBytes ?? DEFAULT_STDOUT_CAP;
  const listCap = options?.listFilesCap ?? LIST_FILES_CAP;
  const chains = new Map<string, Promise<void>>();

  const baseEnv = gitChildEnv;

  /** Spawn git with a wall-clock timeout and a stdout cap; both kill only the child we spawned. */
  function run(args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const child = spawn(gitBin, [...gitPrefixArgs, ...args], {
        cwd: opts.cwd,
        env: opts.env ?? baseEnv(),
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outLen = 0;

      child.stdout.on("data", (c: Buffer) => {
        outLen += c.length;
        if (outLen > maxStdoutBytes) {
          child.kill("SIGKILL");
          done(() =>
            reject(new GitError(args, null, `git stdout exceeded cap of ${maxStdoutBytes} bytes`)),
          );
          return;
        }
        out.push(c);
      });
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", (e) => done(() => reject(e)));
      child.on("close", (code) => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        done(() => {
          if (code !== 0 && !opts.allowFail) {
            reject(new GitError(args, code, stderr.trim()));
            return;
          }
          resolvePromise({ stdout, stderr, code });
        });
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(() => reject(new GitError(args, null, `git timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      if (child.stdin) {
        child.stdin.on("error", () => {});
        if (opts.input !== undefined) child.stdin.write(opts.input);
        child.stdin.end();
      }
    });
  }

  /** Serialize all mutating work on a repo so concurrent checkpoints never fight over lock files. */
  function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return result;
  }

  async function lockKey(cwd: string): Promise<string> {
    const { stdout } = await run(["rev-parse", "--git-common-dir"], { cwd });
    return realpath(resolve(cwd, stdout.trim()));
  }

  async function topLevel(cwd: string): Promise<string> {
    const { stdout } = await run(["rev-parse", "--show-toplevel"], { cwd });
    // git prints forward slashes on Windows; every path below is built with the native separator.
    return resolve(stdout.trim());
  }

  async function headExists(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const res = await run(["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      env,
      allowFail: true,
    });
    return res.code === 0;
  }

  async function assertAgeRef(cwd: string, ref: string): Promise<void> {
    const shaped =
      WOOKY_REF.test(ref) &&
      !ref.includes("..") &&
      !ref.includes("//") &&
      !ref.endsWith("/") &&
      !ref.endsWith(".lock");
    if (!shaped) {
      throw new GitError(
        ["check-ref-format", ref],
        null,
        `ref must be a safe refs/wooky/ or refs/age/ ref: ${ref}`,
      );
    }
    const res = await run(["check-ref-format", ref], { cwd, allowFail: true });
    if (res.code !== 0) {
      throw new GitError(
        ["check-ref-format", ref],
        res.code,
        `ref must be a safe refs/wooky/ or refs/age/ ref: ${ref}`,
      );
    }
  }

  async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "wooky-git-"));
    const indexFile = join(dir, "index");
    try {
      return await fn(baseEnv({ ...WOOKY_IDENTITY, GIT_INDEX_FILE: indexFile }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Stage the whole working tree into a fresh temp index and write its tree object. No ref written. */
  async function writeWorkingTree(top: string, env: NodeJS.ProcessEnv): Promise<string> {
    if (await headExists(top, env)) {
      await run(["read-tree", "HEAD"], { cwd: top, env });
    }
    await run(["add", "-A"], { cwd: top, env });
    const { stdout } = await run(["write-tree"], { cwd: top, env });
    return stdout.trim();
  }

  async function isRepo(cwd: string): Promise<boolean> {
    try {
      const res = await run(["rev-parse", "--is-inside-work-tree"], { cwd, allowFail: true });
      return res.code === 0 && res.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async function captureCheckpoint(cwd: string, ref: string): Promise<string> {
    await assertAgeRef(cwd, ref);
    const top = await topLevel(cwd);
    const key = await lockKey(top);
    return withRepoLock(key, () =>
      withTempIndex(async (env) => {
        const hasHead = await headExists(top, env);
        const tree = await writeWorkingTree(top, env);
        const commitArgs = ["commit-tree", tree, "-m", "wooky checkpoint"];
        if (hasHead) {
          const parent = await run(["rev-parse", "HEAD"], { cwd: top, env });
          commitArgs.push("-p", parent.stdout.trim());
        }
        const commit = await run(commitArgs, { cwd: top, env });
        await run(["update-ref", ref, commit.stdout.trim()], { cwd: top, env });
        return ref;
      }),
    );
  }

  async function restoreCheckpoint(cwd: string, ref: string): Promise<void> {
    await assertAgeRef(cwd, ref);
    const top = await topLevel(cwd);
    const key = await lockKey(top);
    await withRepoLock(key, () =>
      withTempIndex(async (env) => {
        await run(["read-tree", ref], { cwd: top, env });
        await run(["checkout-index", "-a", "-f"], { cwd: top, env });

        const snapshot = await listTree(top, ref, env);
        const current = await listWorkingSet(top);
        const removed: string[] = [];
        const failures: string[] = [];
        for (const rel of current) {
          if (snapshot.has(rel)) continue;
          // `ls-files -o` reports an untracked nested repo as "nested/": never descend or
          // delete it, and skip any directory entry so a non-recursive rm cannot throw EISDIR.
          if (rel.endsWith("/")) continue;
          try {
            await rm(join(top, rel), { force: true });
            removed.push(rel);
          } catch {
            failures.push(rel);
          }
        }

        await dropFromRealIndex(top, removed);
        for (const rel of removed) await pruneEmptyParents(top, join(top, rel));

        if (failures.length > 0) {
          throw new GitError(["restore"], null, `could not remove: ${failures.join(", ")}`);
        }
      }),
    );
  }

  /**
   * Drop exactly the deleted paths from the REAL index (documented exception at top of file)
   * so a later commit cannot record a file restore removed. `--ignore-unmatch` keeps this a
   * no-op for paths that were never staged, leaving every other index entry alone.
   */
  async function dropFromRealIndex(top: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await run(
      ["rm", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { cwd: top, env: baseEnv(), input: paths.join("\0") },
    );
  }

  async function listTree(top: string, ref: string, env: NodeJS.ProcessEnv): Promise<Set<string>> {
    const { stdout } = await run(["ls-tree", "-r", "-z", "--name-only", ref], { cwd: top, env });
    return new Set(stdout.split("\0").filter((p) => p.length > 0));
  }

  async function listWorkingSet(top: string): Promise<Set<string>> {
    const { stdout } = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: top,
    });
    return new Set(stdout.split("\0").filter((p) => p.length > 0));
  }

  async function pruneEmptyParents(top: string, fileAbs: string): Promise<void> {
    let dir = dirname(fileAbs);
    while (dir.length > top.length && dir.startsWith(top)) {
      try {
        const entries = await readdir(dir);
        if (entries.length > 0) break;
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }

  async function diff(cwd: string, from: string, to: string | null): Promise<FileDiff[]> {
    const top = await topLevel(cwd);
    let target = to;
    if (target === null) {
      const key = await lockKey(top);
      target = await withRepoLock(key, () => withTempIndex((env) => writeWorkingTree(top, env)));
    }
    return buildDiff(top, from, target);
  }

  async function buildDiff(top: string, from: string, to: string): Promise<FileDiff[]> {
    const common = ["-c", "core.quotePath=false", "diff", "-M", "--no-ext-diff", "--no-textconv"];
    const nameStatus = await run([...common, "--name-status", "-z", from, to], { cwd: top });
    const numstat = await run([...common, "--numstat", "-z", from, to], { cwd: top });
    const patchOut = await run([...common, from, to], { cwd: top });

    const counts = parseNumstat(numstat.stdout);
    const entries = parseNameStatus(nameStatus.stdout);
    const patches = splitPatches(patchOut.stdout);
    const diffs: FileDiff[] = [];

    // name-status (-z) and the patch both enumerate files in the same diff order, so patches
    // are matched to entries by position. Filenames are never parsed out of the patch text,
    // which lets names containing newlines (quoted in the patch) still receive their patch.
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      const count = counts.get(entry.path);
      const binary = count?.binary ?? false;
      const fileDiff: FileDiff = {
        path: entry.path,
        status: entry.status,
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
      };
      if (entry.oldPath !== undefined) fileDiff.oldPath = entry.oldPath;
      if (!binary) {
        const patch = patches[i];
        if (patch !== undefined) fileDiff.patch = capPatch(patch);
      }
      diffs.push(fileDiff);
    }

    diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return diffs;
  }

  async function createWorktree(projectRoot: string, threadId: string): Promise<Worktree> {
    const top = await topLevel(projectRoot);
    const key = await lockKey(top);
    return withRepoLock(key, async () => {
      if (!(await headExists(top, baseEnv()))) {
        throw new GitError(["worktree", "add"], null, "Isolation needs at least one commit");
      }
      const root = resolve(projectRoot);
      const path = join(dirname(root), ".wooky-worktrees", basename(root), threadId);
      const branch = `wooky/${threadId}`;
      await mkdir(dirname(path), { recursive: true });
      const hasBranch = await run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: top,
        allowFail: true,
      });
      if (hasBranch.code === 0) {
        await run(["worktree", "add", path, branch], { cwd: top });
      } else {
        await run(["worktree", "add", "-b", branch, path, "HEAD"], { cwd: top });
      }
      return { path, branch };
    });
  }

  async function removeWorktree(projectRoot: string, worktree: Worktree): Promise<void> {
    const top = await topLevel(projectRoot);
    const key = await lockKey(top);
    await withRepoLock(key, async () => {
      const res = await run(["worktree", "remove", "--force", worktree.path], {
        cwd: top,
        allowFail: true,
      });
      if (res.code !== 0 && existsSync(worktree.path)) {
        throw new GitError(
          ["worktree", "remove", "--force", worktree.path],
          res.code,
          res.stderr.trim(),
        );
      }
      await run(["worktree", "prune"], { cwd: top });
    });
  }

  async function commitWorktreeChanges(
    projectRoot: string,
    worktree: Worktree,
    message: string,
  ): Promise<void> {
    await topLevel(projectRoot);
    await commitWorktreeImpl(run, baseEnv, worktree, message);
  }

  const merge = createMergeOps({
    run,
    topLevel,
    withRepoLock,
    lockKey,
    baseEnv,
    commitWorktree: async (worktree, message) => {
      await commitWorktreeImpl(run, baseEnv, worktree, message);
    },
  });

  return {
    isRepo,
    createWorktree,
    removeWorktree,
    captureCheckpoint,
    restoreCheckpoint,
    diff,
    listFiles,
    diffBranchStat: merge.diffBranchStat,
    commitWorktreeChanges,
    mergePreview: merge.mergePreview,
    mergeWorktree: merge.mergeWorktree,
  };

  async function listFiles(cwd: string): Promise<string[]> {
    if (!(await isRepo(cwd))) return walkFiles(cwd, listCap);
    const { stdout } = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd,
    });
    const files = new Set<string>();
    for (const entry of stdout.split("\0")) {
      if (entry === "") continue;
      files.add(entry);
      if (files.size >= listCap) break;
    }
    return [...files];
  }
}

export const LIST_FILES_CAP = 50_000;
const WALK_MAX_DEPTH = 12;

/** Bounded breadth-first walk for workspaces that are not git repos. */
async function walkFiles(root: string, cap: number): Promise<string[]> {
  const files: string[] = [];
  let level = [""];
  for (let depth = 0; depth <= WALK_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          next.push(path);
        } else {
          files.push(path);
          if (files.length >= cap) return files;
        }
      }
    }
    level = next;
  }
  return files;
}

interface NameStatusEntry {
  status: FileDiff["status"];
  path: string;
  oldPath?: string;
}

function mapStatus(code: string): FileDiff["status"] {
  const letter = code[0];
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R" || letter === "C") return "renamed";
  return "modified";
}

function parseNameStatus(out: string): NameStatusEntry[] {
  const tokens = out.split("\0");
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status === undefined || status.length === 0) {
      i += 1;
      continue;
    }
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      entries.push({ status: mapStatus(status), path: newPath, oldPath });
      i += 3;
    } else {
      const path = tokens[i + 1] ?? "";
      entries.push({ status: mapStatus(status), path });
      i += 2;
    }
  }
  return entries;
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstat(out: string): Map<string, NumstatEntry> {
  const tokens = out.split("\0");
  const map = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || tok.length === 0) {
      i += 1;
      continue;
    }
    const parts = tok.split("\t");
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const add = parts[0] ?? "";
    const del = parts[1] ?? "";
    const binary = add === "-" || del === "-";
    const additions = binary ? 0 : Number.parseInt(add, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(del, 10) || 0;
    const inlinePath = parts.slice(2).join("\t");
    if (inlinePath.length === 0) {
      const newPath = tokens[i + 2] ?? "";
      map.set(newPath, { additions, deletions, binary });
      i += 3;
    } else {
      map.set(inlinePath, { additions, deletions, binary });
      i += 1;
    }
  }
  return map;
}

/** Split a diff into its per-file chunks by the `diff --git ` header, preserving diff order. */
function splitPatches(out: string): string[] {
  if (out.length === 0) return [];
  return out
    .split(/\n(?=diff --git )/)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((chunk) => (chunk.endsWith("\n") ? chunk : chunk + "\n"));
}

/** Truncate a patch at the byte limit, backing up to a UTF-8 code-point boundary (no U+FFFD). */
function capPatch(patch: string): string {
  const buf = Buffer.from(patch, "utf8");
  if (buf.length <= PATCH_LIMIT) return patch;
  let cut = PATCH_LIMIT;
  while (cut > 0) {
    const byte = buf[cut];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    cut -= 1;
  }
  return buf.subarray(0, cut).toString("utf8") + TRUNCATION_NOTICE;
}
