import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { FileDiff, Worktree } from "@age/contracts";
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

/** Environment variables git hooks leak into a child; they must never reach our plumbing calls. */
const INHERITED_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
] as const;

const AGE_IDENTITY = {
  GIT_AUTHOR_NAME: "AGE",
  GIT_AUTHOR_EMAIL: "age@localhost",
  GIT_COMMITTER_NAME: "AGE",
  GIT_COMMITTER_EMAIL: "age@localhost",
} as const;

const PATCH_LIMIT = 200 * 1024;
const TRUNCATION_NOTICE = "\n… diff truncated\n";

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function createGitService(options?: { gitBin?: string }): GitService {
  const gitBin = options?.gitBin ?? "git";
  const chains = new Map<string, Promise<void>>();

  function baseEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of INHERITED_GIT_VARS) delete env[key];
    env.LC_ALL = "C";
    env.GIT_TERMINAL_PROMPT = "0";
    return { ...env, ...extra };
  }

  function run(args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(gitBin, args, {
        cwd: opts.cwd,
        env: opts.env ?? baseEnv(),
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(err).toString("utf8");
        if (code !== 0 && !opts.allowFail) {
          reject(new GitError(args, code, stderr.trim()));
          return;
        }
        resolvePromise({ stdout, stderr, code });
      });
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
    return resolve(cwd, stdout.trim());
  }

  async function topLevel(cwd: string): Promise<string> {
    const { stdout } = await run(["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  }

  async function headExists(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const res = await run(["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      env,
      allowFail: true,
    });
    return res.code === 0;
  }

  function assertAgeRef(ref: string): void {
    if (!ref.startsWith("refs/age/")) {
      throw new GitError(["update-ref", ref], null, `ref must start with refs/age/: ${ref}`);
    }
  }

  async function withTempIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "age-git-"));
    const indexFile = join(dir, "index");
    try {
      return await fn(baseEnv({ ...AGE_IDENTITY, GIT_INDEX_FILE: indexFile }));
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
    assertAgeRef(ref);
    const top = await topLevel(cwd);
    const key = await lockKey(top);
    return withRepoLock(key, () =>
      withTempIndex(async (env) => {
        const hasHead = await headExists(top, env);
        const tree = await writeWorkingTree(top, env);
        const commitArgs = ["commit-tree", tree, "-m", "age checkpoint"];
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
    assertAgeRef(ref);
    const top = await topLevel(cwd);
    const key = await lockKey(top);
    await withRepoLock(key, () =>
      withTempIndex(async (env) => {
        await run(["read-tree", ref], { cwd: top, env });
        await run(["checkout-index", "-a", "-f"], { cwd: top, env });

        const snapshot = await listTree(top, ref, env);
        const current = await listWorkingSet(top);
        for (const rel of current) {
          if (snapshot.has(rel)) continue;
          const abs = join(top, rel);
          await rm(abs, { force: true });
          await pruneEmptyParents(top, abs);
        }
      }),
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
    const common = ["-c", "core.quotePath=false", "diff", "-M"];
    const nameStatus = await run([...common, "--name-status", "-z", from, to], { cwd: top });
    const numstat = await run([...common, "--numstat", "-z", from, to], { cwd: top });
    const patchOut = await run([...common, from, to], { cwd: top });

    const counts = parseNumstat(numstat.stdout);
    const patches = parsePatches(patchOut.stdout);
    const diffs: FileDiff[] = [];

    for (const entry of parseNameStatus(nameStatus.stdout)) {
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
        const patch = patches.get(entry.path);
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
      const path = join(dirname(root), ".age-worktrees", basename(root), threadId);
      const branch = `age/${threadId}`;
      await mkdir(dirname(path), { recursive: true });
      await run(["worktree", "add", "-b", branch, path, "HEAD"], { cwd: top });
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

  return {
    isRepo,
    createWorktree,
    removeWorktree,
    captureCheckpoint,
    restoreCheckpoint,
    diff,
  };
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

function parsePatches(out: string): Map<string, string> {
  const map = new Map<string, string>();
  if (out.length === 0) return map;
  const chunks = out.split(/\n(?=diff --git )/);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git ")) continue;
    const path = patchPath(chunk);
    if (path !== null) map.set(path, chunk.endsWith("\n") ? chunk : chunk + "\n");
  }
  return map;
}

function patchPath(chunk: string): string | null {
  const plus = chunk.match(/\n\+\+\+ (?:b\/)?(.+)/);
  if (plus && plus[1] !== "/dev/null") return plus[1] ?? null;
  const minus = chunk.match(/\n--- (?:a\/)?(.+)/);
  if (minus && minus[1] !== "/dev/null") return minus[1] ?? null;
  const header = chunk.split("\n", 1)[0] ?? "";
  const m = header.match(/^diff --git a\/(.*) b\/(.*)$/);
  return m ? (m[2] ?? null) : null;
}

function capPatch(patch: string): string {
  if (Buffer.byteLength(patch, "utf8") <= PATCH_LIMIT) return patch;
  const truncated = Buffer.from(patch, "utf8").subarray(0, PATCH_LIMIT).toString("utf8");
  return truncated + TRUNCATION_NOTICE;
}
