/**
 * Shadow repositories for file sync. Each synced project gets a bare repo at
 * WOOKY_HOME/sync/<projectId>.git whose work tree is the project folder. Every call sets
 * GIT_DIR / GIT_WORK_TREE explicitly and uses a private index inside the shadow dir, so the
 * project's own .git, index and refs are never read or written. All git runs are async argv
 * spawns; sync/ code never spawns anything itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { FileDiff } from "@wooky/contracts";
import { gitChildEnv } from "./env.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_SHA = "0".repeat(40);

const onWindows = process.platform === "win32";

function ownedByUs(info: Stats): boolean {
  return onWindows || typeof process.getuid !== "function" || info.uid === process.getuid();
}

/** A real, private entry: not a symlink, ours on POSIX, not writable by group or others. */
function trusted(info: Stats): boolean {
  if (info.isSymbolicLink() || !ownedByUs(info)) return false;
  return onWindows || (info.mode & 0o022) === 0;
}

function isInertConfig(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && trusted(info) && info.size === 0;
  } catch {
    return false;
  }
}

function isInertDir(path: string, empty: boolean): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && trusted(info) && (!empty || readdirSync(path).length === 0);
  } catch {
    return false;
  }
}

let fallbackInertDir: string | null = null;

/**
 * An empty git config file and an empty hooks directory. Calls that have no shadow repo yet
 * (init, --version, plumbing on a project) still need "no global config, no hooks"; the null
 * device cannot stand in, because git on Windows opens `\\.\nul` as a path and fails with
 * "Invalid argument".
 *
 * They live under the Wooky home (`run/git-inert`), not a shared temp directory, where
 * another local user could replace them after a cleaner removed them. Every use re-checks
 * that they are still ours and empty, and rebuilds them if not: a planted config or hook
 * would otherwise run for every git call.
 */
function inertGitFiles(home: string | undefined): { config: string; hooks: string } {
  let dir: string;
  if (home) {
    dir = join(home, "run", "git-inert");
  } else {
    // No home (tests, tools): a private per-process directory instead.
    if (!fallbackInertDir) {
      const created = mkdtempSync(join(tmpdir(), "wooky-git-"));
      fallbackInertDir = created;
      process.once("exit", () => {
        try {
          rmSync(created, { recursive: true, force: true });
        } catch {
          // Best effort: Windows may still hold the directory open.
        }
      });
    }
    dir = fallbackInertDir;
  }
  const config = join(dir, "empty.config");
  const hooks = join(dir, "no-hooks");
  if (isInertDir(dir, false) && isInertConfig(config) && isInertDir(hooks, true)) {
    return { config, hooks };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!onWindows) chmodSync(dir, 0o700);
  writeFileSync(config, "", { mode: 0o600 });
  mkdirSync(hooks, { mode: 0o700 });
  if (!onWindows) chmodSync(hooks, 0o700);
  return { config, hooks };
}

export class ShadowGitError extends Error {
  constructor(
    readonly argv: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${argv.join(" ")} failed (exit ${code ?? "?"}): ${stderr}`);
    this.name = "ShadowGitError";
  }
}

export interface ShadowRepo {
  gitDir: string;
  workTree: string;
}

export interface GitIdentity {
  name: string;
  /** Unix seconds. */
  at: number;
}

interface RunOptions {
  env?: Record<string, string>;
  input?: string | Buffer;
  allowFail?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface RunResult {
  stdout: Buffer;
  text: string;
  stderr: string;
  code: number | null;
}

/** Byte-exact content: no end-of-line, filter or signing config may change what is snapshotted. */
const CONFIG_OVERRIDES = [
  "core.quotePath=false",
  "core.autocrlf=false",
  "core.safecrlf=false",
  "core.fsmonitor=false",
  "core.longpaths=true",
  "commit.gpgsign=false",
  "gc.auto=0",
  "transfer.fsckObjects=true",
  "core.protectNTFS=true",
  "core.protectHFS=true",
].flatMap((entry) => ["-c", entry]);

const EMPTY_BASE_REF = "refs/wooky/empty-base";
const MIN_COMMIT_SECONDS = 946_684_800;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const ATTRIBUTES = "* -text -filter -ident -eol -working-tree-encoding\n";

export type ChangeStatus = "A" | "M" | "D" | "T";
export interface TreeChange {
  status: ChangeStatus;
  path: string;
  /** Blob mode and sha in the target tree; zeros for deletions. */
  mode: string;
  sha: string;
}

/** An apply failed partway; the work tree was rolled back as far as possible. */
export class ApplyFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ApplyFailed";
  }
}

export interface ApplyReport {
  written: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: "unsafe" | "local-only" | "too-large" }>;
}

export interface MergeOutcome {
  tree: string;
  conflicts: string[];
  clean: boolean;
}

export interface LogEntry {
  id: string;
  tree: string;
  parentId: string | null;
  message: string;
  summary: { filesChanged: number; insertions: number; deletions: number };
}

export interface ScanOptions {
  includeIgnored: boolean;
  /** Relative posix paths (files or folders) that are never snapshotted. */
  exclude: readonly string[];
  maxFileBytes: number;
  /** An extra exclude file, e.g. the project's own .git/info/exclude. */
  excludeFrom?: string;
}

export interface ScanResult {
  fingerprint: string;
  add: string[];
  remove: string[];
  skipped: Array<{ path: string; bytes: number }>;
  stamps: ReadonlyMap<string, string>;
}

/** HFS+ and NTFS fold format characters away; a zero-width spelling must not slip past. */
const FORMAT_CHARS = /\p{Cf}/gu;

/** True for `.git` and the spellings NTFS or HFS+ resolve to it: `git~1`, `.git.`, `.git `, `.g\u200cit`. */
function isDotGitAlias(part: string): boolean {
  const base = part.split(":")[0] ?? part;
  const name = base.normalize("NFKC").replace(FORMAT_CHARS, "").toLowerCase();
  const trimmed = name.replace(/[. ]+$/, "");
  return trimmed === ".git" || /^git~\d+$/.test(trimmed);
}

/** Control characters would break the line-oriented git plumbing formats (index-info). */
function hasControlChars(path: string): boolean {
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Rejects anything that could land outside the work tree or inside a .git folder. */
export function safeRelativePath(path: string): string | null {
  if (path.length === 0 || hasControlChars(path) || path.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(path)) return null;
  if (sep === "\\" && path.includes("\\")) return null;
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return null;
    // NTFS strips trailing dots and spaces, so `.. ` and `...` resolve like `.` / `..`.
    if (part.replace(/[. ]+$/, "") === "") return null;
    if (isDotGitAlias(part)) return null;
  }
  return path;
}

function underExclusion(path: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/** Windows holds files open (AV, indexers); a short retry rides out EBUSY and EPERM. */
async function retryBusy<T>(fn: () => Promise<T>): Promise<T> {
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const text =
        error instanceof Error
          ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ""}`
          : "";
      if (attempt >= attempts || !/EBUSY|EPERM|Permission denied|busy/i.test(text)) throw error;
      await new Promise((done) => setTimeout(done, 50 * attempt * attempt));
    }
  }
}

export function createShadowGit(
  options: {
    gitBin?: string;
    /** WOOKY_HOME: where the inert git config and hooks directory live. */
    home?: string;
    /** Test seam: runs after the temporary file is written and before the final checks. */
    beforeCommit?: (finalPath: string) => Promise<void>;
  } = {},
) {
  const beforeCommit = options.beforeCommit;
  const gitBin = options.gitBin ?? "git";
  const home = options.home;

  function environment(repo: ShadowRepo | null, extra?: Record<string, string>) {
    const env = gitChildEnv();
    // Nothing from the user's ambient git setup may reach the shadow repo: no dates, no
    // global or system config, no hooks.
    for (const key of [
      "GIT_AUTHOR_DATE",
      "GIT_COMMITTER_DATE",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
    ]) {
      delete env[key];
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_ATTR_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = repo
      ? join(repo.gitDir, "wooky-empty.config")
      : inertGitFiles(home).config;
    if (repo) {
      env.GIT_DIR = repo.gitDir;
      env.GIT_WORK_TREE = repo.workTree;
    }
    return { ...env, ...extra };
  }

  function identityEnv(identity: GitIdentity): Record<string, string> {
    // Git rejects dates near the epoch, so clamp to the year 2000.
    const date = `${Math.max(Math.floor(identity.at), MIN_COMMIT_SECONDS)} +0000`;
    return {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: "wooky@localhost",
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: "wooky@localhost",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
  }

  function launch(repo: ShadowRepo | null, args: string[], opts: RunOptions): ChildProcess {
    const hooks = [
      "-c",
      `core.hooksPath=${repo ? join(repo.gitDir, "wooky-no-hooks") : inertGitFiles(home).hooks}`,
    ];
    return spawn(gitBin, [...CONFIG_OVERRIDES, ...hooks, ...args], {
      // The work tree, so git never computes a prefix when the shadow dir sits inside the project.
      cwd: repo?.workTree ?? process.cwd(),
      env: environment(repo, opts.env),
      windowsHide: true,
    });
  }

  function run(repo: ShadowRepo | null, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const child = launch(repo, args, opts);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new ShadowGitError(args, null, `timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          child.kill("SIGKILL");
          finish(() => reject(new ShadowGitError(args, null, "output exceeded the size cap")));
          return;
        }
        out.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => {
        const stdout = Buffer.concat(out);
        const stderr = Buffer.concat(err).toString("utf8").trim();
        finish(() => {
          if (code !== 0 && !opts.allowFail) reject(new ShadowGitError(args, code, stderr));
          else resolvePromise({ stdout, text: stdout.toString("utf8"), stderr, code });
        });
      });
      child.stdin?.on("error", () => {});
      if (opts.input !== undefined) child.stdin?.write(opts.input);
      child.stdin?.end();
    });
  }

  const indexOf = (repo: ShadowRepo) => join(repo.gitDir, "wooky.index");
  const withIndex = (file: string) => ({ GIT_INDEX_FILE: file });

  async function version(): Promise<[number, number, number] | null> {
    try {
      const { text } = await run(null, ["--version"]);
      const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    } catch {
      return null;
    }
  }

  const prepared = new Set<string>();
  const stagedStamps = new Map<string, Map<string, string>>();

  /** Creates the shadow repo on first use and points core.worktree at the project. */
  async function ensure(repo: ShadowRepo): Promise<void> {
    const key = `${repo.gitDir}\0${repo.workTree}`;
    if (prepared.has(key)) return;
    if (!existsSync(join(repo.gitDir, "HEAD"))) {
      await mkdir(dirname(repo.gitDir), { recursive: true });
      await run(null, ["init", "--bare", "--quiet", "--template=", repo.gitDir]);
    }
    await run(repo, ["config", "core.bare", "false"]);
    await run(repo, ["config", "core.worktree", repo.workTree]);
    await run(repo, ["config", "core.logAllRefUpdates", "false"]);
    await mkdir(join(repo.gitDir, "info"), { recursive: true });
    await mkdir(join(repo.gitDir, "wooky-no-hooks"), { recursive: true });
    await writeFile(join(repo.gitDir, "wooky-empty.config"), "");
    await writeFile(join(repo.gitDir, "info", "attributes"), ATTRIBUTES);
    prepared.add(key);
  }

  async function rev(repo: ShadowRepo, spec: string): Promise<string | null> {
    const res = await run(repo, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`], {
      allowFail: true,
    });
    const sha = res.text.trim();
    return res.code === 0 && sha ? sha : null;
  }

  async function treeOf(repo: ShadowRepo, commitOrTree: string): Promise<string> {
    const res = await run(repo, ["rev-parse", "--verify", `${commitOrTree}^{tree}`]);
    return res.text.trim();
  }

  async function updateRef(
    repo: ShadowRepo,
    ref: string,
    sha: string,
    expectOld?: string | null,
  ): Promise<void> {
    const args = ["update-ref", ref, sha];
    if (expectOld !== undefined) args.push(expectOld ?? ZERO_SHA);
    await run(repo, args);
  }

  async function listRefs(repo: ShadowRepo, prefix: string): Promise<string[]> {
    const res = await run(repo, ["for-each-ref", "--format=%(refname)", prefix]);
    return res.text.split("\n").filter(Boolean);
  }

  async function commit(
    repo: ShadowRepo,
    input: { tree: string; parent: string | null; message: string; identity: GitIdentity },
  ): Promise<string> {
    const args = ["commit-tree", input.tree];
    if (input.parent) args.push("-p", input.parent);
    const res = await run(repo, args, {
      input: input.message,
      env: identityEnv(input.identity),
    });
    return res.text.trim();
  }

  /** Lists what a snapshot would hold, applying the cap, the exclusions and the ignore rules. */
  async function scan(repo: ShadowRepo, opts: ScanOptions): Promise<ScanResult> {
    const args = ["ls-files", "-z", "-t", "-c", "-o"];
    if (!opts.includeIgnored) {
      args.push("--exclude-standard");
      if (opts.excludeFrom) args.push(`--exclude-from=${opts.excludeFrom}`);
    }
    const listed = await run(repo, args, { env: withIndex(indexOf(repo)) });
    const entries: Array<{ path: string; cached: boolean }> = [];
    for (const raw of listed.text.split("\0")) {
      if (raw.length < 3) continue;
      const path = raw.slice(2);
      // A trailing slash marks a nested repository; it is not part of the snapshot.
      if (path.endsWith("/")) continue;
      entries.push({ path, cached: raw[0] === "H" });
    }

    const add: Array<{ path: string; stamp: string }> = [];
    const removed: string[] = [];
    const skipped: ScanResult["skipped"] = [];
    const BATCH = 128;
    for (let start = 0; start < entries.length; start += BATCH) {
      const batch = entries.slice(start, start + BATCH);
      await Promise.all(
        batch.map(async ({ path, cached }) => {
          if (underExclusion(path, opts.exclude) || safeRelativePath(path) === null) {
            if (cached) removed.push(path);
            return;
          }
          let info;
          try {
            info = await lstat(join(repo.workTree, path), { bigint: true });
          } catch {
            if (cached) removed.push(path);
            return;
          }
          if (info.isFile() && info.size > BigInt(opts.maxFileBytes)) {
            skipped.push({ path, bytes: Number(info.size) });
            if (cached) removed.push(path);
            return;
          }
          if (!info.isFile() && !info.isSymbolicLink()) {
            if (cached) removed.push(path);
            return;
          }
          add.push({
            path,
            stamp: `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.mode}:${info.ino}`,
          });
        }),
      );
    }
    add.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const hash = createHash("sha1");
    const stamps = new Map<string, string>();
    for (const item of add) {
      hash.update(`${item.path}\0${item.stamp}\n`);
      stamps.set(item.path, item.stamp);
    }
    skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
    return {
      fingerprint: hash.digest("hex"),
      add: add.map((item) => item.path),
      remove: removed,
      skipped,
      stamps,
    };
  }

  /** Brings the private index in line with a scan. Returns the tree sha. */
  async function stage(repo: ShadowRepo, result: ScanResult): Promise<string> {
    const index = indexOf(repo);
    const env = withIndex(index);
    const prev = stagedStamps.get(repo.gitDir);
    stagedStamps.delete(repo.gitDir);
    // Git on Windows maps st_ctime to creation time and compares mtime at 1s resolution, so
    // update-index trusts stale entries after a same-size rewrite with a restored mtime. Evict
    // paths whose Node lstat stamp changed (NTFS ChangeTime) so git must re-hash them.
    if (process.platform === "win32" && !prev && existsSync(index)) {
      await rm(index, { force: true });
    }
    const rehash: string[] = [];
    if (prev) {
      for (const path of result.add) {
        const before = prev.get(path);
        if (before !== undefined && before !== result.stamps.get(path)) rehash.push(path);
      }
    }
    const toRemove = rehash.length > 0 ? [...result.remove, ...rehash] : result.remove;
    if (toRemove.length > 0) {
      await run(repo, ["update-index", "--force-remove", "-z", "--stdin"], {
        env,
        input: toRemove.join("\0") + "\0",
      });
    }
    if (result.add.length > 0) {
      await run(repo, ["update-index", "--add", "--replace", "-z", "--stdin"], {
        env,
        input: result.add.join("\0") + "\0",
      });
    }
    const tree = await run(repo, ["write-tree"], { env });
    stagedStamps.set(repo.gitDir, new Map(result.stamps));
    return tree.text.trim();
  }

  /** The next scan must re-read every file: used after files were written by restore or apply. */
  async function dropIndex(repo: ShadowRepo): Promise<void> {
    stagedStamps.delete(repo.gitDir);
    await rm(indexOf(repo), { force: true });
  }

  function shortstat(text: string): LogEntry["summary"] {
    const num = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
    return {
      filesChanged: num(/(\d+) files? changed/),
      insertions: num(/(\d+) insertions?\(\+\)/),
      deletions: num(/(\d+) deletions?\(-\)/),
    };
  }

  async function log(repo: ShadowRepo, ref: string, max: number): Promise<LogEntry[]> {
    if (!(await rev(repo, ref))) return [];
    const res = await run(
      repo,
      [
        "log",
        "--first-parent",
        "--shortstat",
        `--max-count=${max}`,
        "--format=%x1e%H%x00%T%x00%P%x00%B%x00",
        ref,
      ],
      { allowFail: true },
    );
    if (res.code !== 0) return [];
    const entries: LogEntry[] = [];
    for (const record of res.text.split("\x1e")) {
      if (!record.trim()) continue;
      const [id, tree, parents, message, stat] = record.split("\0");
      if (!id || !tree) continue;
      entries.push({
        id,
        tree,
        parentId: parents?.split(" ")[0] || null,
        message: message ?? "",
        summary: shortstat(stat ?? ""),
      });
    }
    return entries;
  }

  async function commitMessage(repo: ShadowRepo, sha: string): Promise<string> {
    const res = await run(repo, ["show", "-s", "--format=%B", sha]);
    return res.text;
  }

  async function diffStat(
    repo: ShadowRepo,
    from: string,
    to: string,
  ): Promise<LogEntry["summary"]> {
    const res = await run(repo, ["diff", "--shortstat", "--no-renames", from, to]);
    return shortstat(res.text);
  }

  async function changes(repo: ShadowRepo, from: string, to: string): Promise<TreeChange[]> {
    const res = await run(repo, ["diff-tree", "-r", "-z", "--raw", "--no-renames", from, to]);
    const tokens = res.text.split("\0");
    const out: TreeChange[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const meta = tokens[i];
      const path = tokens[i + 1];
      if (!meta?.startsWith(":") || path === undefined) continue;
      const [, newMode, , newSha, status] = meta.split(/[ ]/);
      const letter = status?.[0];
      if (letter !== "A" && letter !== "M" && letter !== "D" && letter !== "T") continue;
      out.push({ status: letter, path, mode: newMode ?? "", sha: newSha ?? "" });
    }
    return out;
  }

  /** Same shape as GitService.diff, computed inside the shadow repo. */
  async function diff(repo: ShadowRepo, from: string, to: string): Promise<FileDiff[]> {
    const common = ["diff", "-M", "--no-ext-diff", "--no-textconv"];
    const nameStatus = await run(repo, [...common, "--name-status", "-z", from, to]);
    const numstat = await run(repo, [...common, "--numstat", "-z", from, to]);
    const patchOut = await run(repo, [...common, from, to]);
    const counts = parseNumstat(numstat.text);
    const entries = parseNameStatus(nameStatus.text);
    const patches = splitPatches(patchOut.text);
    const files: FileDiff[] = [];
    entries.forEach((entry, i) => {
      const count = counts.get(entry.path);
      const file: FileDiff = {
        path: entry.path,
        status: entry.status,
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
      };
      if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
      const patch = patches[i];
      if (!count?.binary && patch !== undefined) file.patch = capPatch(patch);
      files.push(file);
    });
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return files;
  }

  async function removeFile(repo: ShadowRepo, relative: string): Promise<void> {
    const absolute = join(repo.workTree, relative);
    const root = await realpath(repo.workTree);
    let parent: string;
    try {
      parent = await realpath(dirname(absolute));
    } catch {
      return;
    }
    if (parent !== root && !parent.startsWith(root + sep)) return;
    try {
      const info = await lstat(absolute);
      if (info.isDirectory()) return;
      await retryBusy(() => unlink(absolute));
    } catch {
      return;
    }
    let dir = dirname(absolute);
    while (dir !== repo.workTree && dir.startsWith(repo.workTree + sep)) {
      try {
        if ((await readdir(dir)).length > 0) break;
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }

  /** `cat-file --batch-check` over `<tree>:<path>` lines: the blob size, or null when absent. */
  async function blobSizes(
    repo: ShadowRepo,
    tree: string,
    paths: readonly string[],
  ): Promise<Map<string, number | null>> {
    const sizes = new Map<string, number | null>();
    if (paths.length === 0) return sizes;
    const res = await run(repo, ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], {
      input: paths.map((path) => `${tree}:${path}`).join("\n") + "\n",
    });
    const lines = res.text.split("\n");
    paths.forEach((path, i) => {
      const [type, size] = (lines[i] ?? "").split(" ");
      sizes.set(path, type === "blob" ? Number(size) : null);
    });
    return sizes;
  }

  async function existsOnDisk(repo: ShadowRepo, relative: string): Promise<boolean> {
    try {
      await lstat(join(repo.workTree, relative));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes the given changes into the work tree. Nothing outside the snapshot is touched:
   *  - paths that could escape the work tree or reach a .git alias are refused;
   *  - with `mineTree`, a path that exists on disk but is not in that tree (ignored, over the
   *    cap, never snapshotted) is skipped, because no backup holds its bytes;
   *  - incoming blobs over `maxFileBytes`, or a total over `maxTotalBytes`, are refused;
   *  - target blobs are written first and deletions only after that succeeded, so a failed
   *    write leaves every deletion undone.
   */
  async function applyChanges(
    repo: ShadowRepo,
    targetTree: string,
    list: readonly TreeChange[],
    rules: {
      exclude: readonly string[];
      mineTree: string | null;
      maxFileBytes: number;
      maxTotalBytes: number;
      /** Rollback mode: carry on past a path that cannot be written. */
      bestEffort?: boolean;
    },
  ): Promise<ApplyReport> {
    const skipped: ApplyReport["skipped"] = [];
    const usable: TreeChange[] = [];
    for (const change of list) {
      if (safeRelativePath(change.path) === null)
        skipped.push({ path: change.path, reason: "unsafe" });
      else if (!underExclusion(change.path, rules.exclude)) usable.push(change);
    }
    const writes: TreeChange[] = [];
    const removals: TreeChange[] = [];
    const sizes = await blobSizes(
      repo,
      targetTree,
      usable.filter((c) => c.status !== "D").map((c) => c.path),
    );
    const inMine = rules.mineTree
      ? await blobSizes(
          repo,
          rules.mineTree,
          usable.filter((c) => c.status === "A" || c.status === "T").map((c) => c.path),
        )
      : null;
    let total = 0;
    for (const change of usable) {
      if (change.status === "D") {
        removals.push(change);
        continue;
      }
      if (change.status === "T") removals.push(change);
      if (inMine && (change.status === "A" || change.status === "T")) {
        const known = inMine.get(change.path) !== null && inMine.get(change.path) !== undefined;
        if (!known && (await existsOnDisk(repo, change.path))) {
          skipped.push({ path: change.path, reason: "local-only" });
          removals.splice(removals.indexOf(change), 1);
          continue;
        }
      }
      const size = sizes.get(change.path) ?? 0;
      if (size > rules.maxFileBytes) {
        skipped.push({ path: change.path, reason: "too-large" });
        continue;
      }
      total += size;
      writes.push(change);
    }
    if (total > rules.maxTotalBytes) {
      throw new ApplyFailed("The incoming change is too large to apply.");
    }
    try {
      if (writes.length > 0) {
        // Only the entries being written go into the throwaway index, so a hostile entry
        // elsewhere in the tree is never even parsed.
        const tmp = join(repo.gitDir, `apply-${process.pid}-${Date.now()}.index`);
        try {
          await run(repo, ["update-index", "--add", "--index-info"], {
            env: withIndex(tmp),
            input: writes.map((c) => `${c.mode} ${c.sha} 0\t${c.path}\n`).join(""),
          });
          await retryBusy(() =>
            run(repo, ["checkout-index", "-f", "-z", "--stdin"], {
              env: withIndex(tmp),
              input: writes.map((c) => c.path).join("\0") + "\0",
              allowFail: rules.bestEffort === true,
            }),
          );
        } finally {
          await rm(tmp, { force: true });
          await dropIndex(repo);
        }
      }
      for (const change of removals) await removeFile(repo, change.path);
    } catch (error) {
      const cause =
        error instanceof ShadowGitError && error.stderr
          ? error.stderr
          : error instanceof Error
            ? error.message
            : String(error);
      if (!rules.mineTree) throw error;
      // Best effort: put back every path this apply could have touched. The caller checks
      // whether the folder really matches the backup again.
      try {
        const touched = new Set([...writes, ...removals].map((c) => c.path));
        const back = (await changes(repo, targetTree, rules.mineTree)).filter((c) =>
          touched.has(c.path),
        );
        await applyChanges(repo, rules.mineTree, back, {
          exclude: rules.exclude,
          mineTree: null,
          maxFileBytes: Number.MAX_SAFE_INTEGER,
          maxTotalBytes: Number.MAX_SAFE_INTEGER,
          bestEffort: true,
        });
      } catch {
        // Reported by the caller's verification.
      }
      throw new ApplyFailed(cause);
    }
    await dropIndex(repo);
    return { written: writes.map((c) => c.path), deleted: removals.map((c) => c.path), skipped };
  }

  /** Lowercased on Windows, where paths compare without case. */
  const foldCase = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

  /**
   * Walks `relative` under the work tree one component at a time with lstat. Every existing
   * directory component must be a real directory (no symlink, junction or file). With `create`,
   * missing directories are made one level at a time, so nothing is ever created through a link.
   * Returns the verified parent directory, or null when the path is unsafe.
   */
  async function verifiedParent(
    repo: ShadowRepo,
    relative: string,
    create: boolean,
  ): Promise<string | null> {
    let root: string;
    try {
      root = await realpath(repo.workTree);
    } catch {
      return null;
    }
    const dirs = relative.split("/").slice(0, -1);
    let current = root;
    for (const part of dirs) {
      current = join(current, part);
      let info = await lstat(current).catch(() => null);
      if (info === null) {
        if (!create) return null;
        try {
          await mkdir(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        info = await lstat(current).catch(() => null);
      }
      if (info === null || info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    const real = await realpath(current).catch(() => null);
    if (real === null) return null;
    // Catches what lstat cannot see, such as a reparse point that is not a symlink.
    if (foldCase(real) !== foldCase(current)) return null;
    if (real !== root && !real.startsWith(root + sep)) return null;
    return current;
  }

  /**
   * Writes one file the engine builds itself (a `.theirs` copy). Same rules as an apply: a
   * path that is on disk but not in `mineTree` is left alone. Nothing is ever written through
   * a link: every component under the work tree is checked with lstat before anything is
   * created, a final symlink or non-regular file is refused, and the bytes go to a temporary
   * file in the verified folder that is renamed into place (rename replaces a link, it never
   * follows it). The folder is checked again right before the rename.
   */
  async function writeWorkFile(
    repo: ShadowRepo,
    relative: string,
    data: Buffer,
    mineTree: string,
  ): Promise<"written" | "not-in-snapshot" | "unsafe"> {
    if (safeRelativePath(relative) === null) return "unsafe";
    const absolute = join(repo.workTree, relative);
    const existing = await lstat(absolute).catch(() => null);
    if (existing !== null) {
      if (!existing.isFile()) return "unsafe";
      const known = (await blobSizes(repo, mineTree, [relative])).get(relative);
      if (known === null || known === undefined) return "not-in-snapshot";
    }
    const parent = await verifiedParent(repo, relative, true);
    if (parent === null) return "unsafe";
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    const final = join(parent, name);
    const temp = join(parent, `.wooky-${randomBytes(8).toString("hex")}.tmp`);
    const long = (path: string) =>
      process.platform === "win32" ? `\\\\?\\${resolve(path)}` : path;
    // O_EXCL refuses an existing path, links included; O_NOFOLLOW is the second guard.
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0);
    const mode = existing !== null ? existing.mode & 0o777 : 0o666;
    try {
      const handle = await open(long(temp), flags, mode);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      await beforeCommit?.(final);
      const again = await verifiedParent(repo, relative, false);
      if (again !== parent) return "unsafe";
      const last = await lstat(final).catch(() => null);
      if (last !== null && !last.isFile()) return "unsafe";
      await retryBusy(() => rename(long(temp), long(final)));
      await dropIndex(repo);
      return "written";
    } finally {
      await rm(long(temp), { force: true }).catch(() => {});
    }
  }

  /** Keeps a commit alive through gc (and a crash) with a ref of its own. */
  async function holdRef(repo: ShadowRepo, sha: string, hold: boolean): Promise<void> {
    const ref = `refs/wooky/hold/${sha}`;
    if (hold) {
      if (await rev(repo, sha)) await updateRef(repo, ref, sha);
    } else {
      await run(repo, ["update-ref", "-d", ref], { allowFail: true });
    }
  }

  async function heldShas(repo: ShadowRepo): Promise<string[]> {
    const refs = await listRefs(repo, "refs/wooky/hold/");
    return refs.map((ref) => ref.slice("refs/wooky/hold/".length));
  }

  /** The empty-tree commit used as the merge base for a first sync. Anchored so gc keeps it. */
  async function emptyBase(repo: ShadowRepo): Promise<string> {
    const known = await rev(repo, EMPTY_BASE_REF);
    if (known) return known;
    const id = await commit(repo, {
      tree: EMPTY_TREE,
      parent: null,
      message: "wooky: empty base\n",
      identity: { name: "Wooky", at: MIN_COMMIT_SECONDS },
    });
    await updateRef(repo, EMPTY_BASE_REF, id);
    return id;
  }

  async function blobAt(repo: ShadowRepo, from: string, path: string): Promise<Buffer | null> {
    const res = await run(repo, ["cat-file", "blob", `${from}:${path}`], { allowFail: true });
    return res.code === 0 ? res.stdout : null;
  }

  /** The mode of one entry in a tree, or null when it is absent. */
  async function modeAt(repo: ShadowRepo, from: string, path: string): Promise<string | null> {
    const res = await run(repo, ["ls-tree", "-z", from, "--", path], { allowFail: true });
    if (res.code !== 0) return null;
    const entry = res.text.split("\0")[0] ?? "";
    const mode = /^(\d+) /.exec(entry)?.[1];
    return entry.endsWith(`\t${path}`) && mode ? mode : null;
  }

  /** `git merge-tree --write-tree` (Git 2.40+ for --merge-base). Conflicts are not applied anywhere. */
  async function mergeTree(
    repo: ShadowRepo,
    input: { base: string; mine: string; theirs: string },
  ): Promise<MergeOutcome> {
    const res = await run(
      repo,
      [
        "merge-tree",
        "--write-tree",
        "-z",
        "--name-only",
        "--no-messages",
        `--merge-base=${input.base}`,
        input.mine,
        input.theirs,
      ],
      { allowFail: true },
    );
    if (res.code !== 0 && res.code !== 1) {
      throw new ShadowGitError(["merge-tree"], res.code, res.stderr);
    }
    const [tree, ...rest] = res.text.split("\0");
    if (!tree) throw new ShadowGitError(["merge-tree"], res.code, "no tree was written");
    const conflicts = rest.filter(Boolean);
    return { tree, conflicts, clean: res.code === 0 };
  }

  /** Replaces the given paths in a merged tree with the entries from one side (or removes them). */
  async function pickSide(
    repo: ShadowRepo,
    input: { merged: string; side: string; paths: readonly string[] },
  ): Promise<string> {
    const tmp = join(repo.gitDir, `pick-${process.pid}-${Date.now()}.index`);
    // A path that cannot be written safely is dropped from the result, never passed to the
    // line-oriented index-info format (a newline in a name would inject extra entries).
    const safe = input.paths.filter((path) => safeRelativePath(path) !== null);
    try {
      const env = withIndex(tmp);
      await run(repo, ["read-tree", input.merged], { env });
      await run(repo, ["update-index", "--force-remove", "-z", "--stdin"], {
        env,
        input: input.paths.join("\0") + "\0",
      });
      const listed =
        safe.length === 0
          ? null
          : await run(repo, ["ls-tree", "-r", "-z", input.side, "--", ...safe]);
      if (listed?.text.length) {
        const lines = listed.text
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t");
            const [mode, , sha] = line.slice(0, tab).split(" ");
            return `${mode} ${sha} 0\t${line.slice(tab + 1)}`;
          });
        await run(repo, ["update-index", "--add", "--index-info"], {
          env,
          input: lines.join("\n") + "\n",
        });
      }
      const tree = await run(repo, ["write-tree"], { env });
      return tree.text.trim();
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async function bundleHeads(repo: ShadowRepo, file: string): Promise<string[]> {
    const res = await run(repo, ["bundle", "list-heads", file]);
    return res.text
      .split("\n")
      .map((line) => line.split(" ")[1])
      .filter((ref): ref is string => Boolean(ref));
  }

  async function bundleVerify(repo: ShadowRepo, file: string): Promise<void> {
    await run(repo, ["bundle", "verify", file]);
  }

  async function fetchBundle(
    repo: ShadowRepo,
    file: string,
    source: string,
    target: string,
  ): Promise<void> {
    await run(repo, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      file,
      `+${source}:${target}`,
    ]);
  }

  /** Starts `git bundle create -`; the caller pipes stdout and awaits `done`. */
  function bundleStream(
    repo: ShadowRepo,
    ref: string,
    have: string | null,
  ): { stdout: Readable; done: Promise<void>; kill(): void } {
    const args = ["bundle", "create", "-", ref];
    if (have) args.push(`^${have}`);
    const child = launch(repo, args, {});
    const errors: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    const done = new Promise<void>((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new ShadowGitError(args, code, Buffer.concat(errors).toString("utf8").trim()));
      });
    });
    done.catch(() => {});
    return { stdout: child.stdout as Readable, done, kill: () => void child.kill("SIGKILL") };
  }

  async function gc(repo: ShadowRepo): Promise<void> {
    await run(repo, ["gc", "--prune=now", "--quiet"]);
  }

  async function fsck(repo: ShadowRepo): Promise<void> {
    await run(repo, ["fsck", "--strict"]);
  }

  /** HEAD sha and branch of the project's own repo, read only. Null when it is not a git repo. */
  async function projectHead(
    root: string,
  ): Promise<{ head: string; branch: string | null } | null> {
    if (!existsSync(join(root, ".git"))) return null;
    const head = await run(null, ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], {
      allowFail: true,
    });
    if (head.code !== 0) return null;
    const branch = await run(null, ["-C", root, "symbolic-ref", "--short", "--quiet", "HEAD"], {
      allowFail: true,
    });
    return { head: head.text.trim(), branch: branch.code === 0 ? branch.text.trim() : null };
  }

  async function remove(repo: ShadowRepo): Promise<void> {
    stagedStamps.delete(repo.gitDir);
    await rm(repo.gitDir, { recursive: true, force: true });
  }

  return {
    run,
    version,
    ensure,
    rev,
    treeOf,
    updateRef,
    listRefs,
    commit,
    scan,
    stage,
    dropIndex,
    log,
    commitMessage,
    diffStat,
    changes,
    diff,
    applyChanges,
    writeWorkFile,
    modeAt,
    blobSizes,
    holdRef,
    heldShas,
    emptyBase,
    blobAt,
    mergeTree,
    pickSide,
    bundleHeads,
    bundleVerify,
    fetchBundle,
    bundleStream,
    gc,
    fsck,
    remove,
    projectHead,
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
    if (status[0] === "R" || status[0] === "C") {
      entries.push({
        status: mapStatus(status),
        path: tokens[i + 2] ?? "",
        oldPath: tokens[i + 1] ?? "",
      });
      i += 3;
    } else {
      entries.push({ status: mapStatus(status), path: tokens[i + 1] ?? "" });
      i += 2;
    }
  }
  return entries;
}

function parseNumstat(
  out: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = out.split("\0");
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i += 1;
      continue;
    }
    const parts = token.split("\t");
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const binary = parts[0] === "-" || parts[1] === "-";
    const stat = {
      additions: binary ? 0 : Number.parseInt(parts[0] ?? "", 10) || 0,
      deletions: binary ? 0 : Number.parseInt(parts[1] ?? "", 10) || 0,
      binary,
    };
    const inline = parts.slice(2).join("\t");
    if (inline.length === 0) {
      map.set(tokens[i + 2] ?? "", stat);
      i += 3;
    } else {
      map.set(inline, stat);
      i += 1;
    }
  }
  return map;
}

function splitPatches(out: string): string[] {
  if (out.length === 0) return [];
  return out
    .split(/\n(?=diff --git )/)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((chunk) => (chunk.endsWith("\n") ? chunk : `${chunk}\n`));
}

const PATCH_LIMIT = 200 * 1024;

function capPatch(patch: string): string {
  const buf = Buffer.from(patch, "utf8");
  if (buf.length <= PATCH_LIMIT) return patch;
  let cut = PATCH_LIMIT;
  while (cut > 0) {
    const byte = buf[cut];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    cut -= 1;
  }
  return `${buf.subarray(0, cut).toString("utf8")}\n… diff truncated\n`;
}
