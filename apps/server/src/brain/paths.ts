import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  BRAIN_MAX_SEGMENTS,
  BRAIN_OVERVIEW_FILE,
  isBrainSegment,
  type BrainScope,
} from "@wooky/contracts";
import { ServiceError } from "../errors.ts";

/** Hand-edited files bigger than this are skipped when scanning and refused when read. */
export const MAX_FILE_BYTES = 64 * 1024;
/** A cloned repo can hold anything; stop walking after this many directory entries. */
const MAX_SCAN_ENTRIES = 5000;

export type BrainLog = (message: string) => void;

/**
 * Directory entries one walk, or one group of walks that must stay bounded together, may read.
 * A list makes one and shares it with its folder counts; a write gives its memory-count check
 * and its overview refresh one each; a reindex has one. A hostile tree costs at most this much
 * per budget however many folders it has.
 */
export interface ScanBudget {
  remaining: number;
  used: number;
  /** True once an entry was left unread because the budget ran out. */
  truncated: boolean;
  /** Asked now and then; when it says yes the walk ends as if the budget had run out. */
  stop?: () => boolean;
}

/** A walk asks `stop` this often, in directory entries, as well as once per folder. */
const STOP_EVERY = 128;

export function createScanBudget(
  limit: number = MAX_SCAN_ENTRIES,
  stop?: () => boolean,
): ScanBudget {
  return stop === undefined
    ? { remaining: limit, used: 0, truncated: false }
    : { remaining: limit, used: 0, truncated: false, stop };
}

export interface ScanResult {
  files: ScannedFile[];
  /** True when the walk stopped early: the budget ran out or `maxFiles` was reached. */
  truncated: boolean;
  /**
   * Every folder the walk reached, keyed by its path below the brain root (`""` is the root),
   * with the number of memories under it. Meaningful only when the walk was not truncated.
   */
  folders: Map<string, number>;
}

export interface ChildList {
  entries: { name: string; isDir: boolean }[];
  /** False when the budget ran out before every entry was read. */
  complete: boolean;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function forbidden(message: string): ServiceError {
  return new ServiceError("forbidden", message);
}

/** The real path of a path that may not exist yet: its nearest existing ancestor, resolved, plus the rest. */
export function realpathNearest(path: string): string {
  const start = resolve(path);
  const rest: string[] = [];
  let current = start;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length === 0 ? real : join(real, ...rest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return start;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/** Opens without following a link and without blocking on a pipe swapped in after the lstat. */
export const READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export interface RegularFile {
  raw: Buffer;
  mtimeMs: number;
  size: number;
}

/** Reads a regular file by descriptor. Anything else, or a hard-linked file when asked, is refused. */
export function readRegularFile(
  abs: string,
  label: string,
  options: { refuseHardLinks?: boolean } = {},
): RegularFile {
  const fd = openSync(abs, READ_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw forbidden(`${label} is not a regular file`);
    if (options.refuseHardLinks === true && stat.nlink > 1) {
      throw forbidden(`${label} has other hard links and is not read`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new ServiceError(
        "bad_request",
        `${label} is ${stat.size} bytes; brain files over ${MAX_FILE_BYTES} are not read`,
      );
    }
    const raw = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < raw.length) {
      const count = readSync(fd, raw, offset, raw.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return { raw: raw.subarray(0, offset), mtimeMs: stat.mtimeMs, size: offset };
  } finally {
    closeSync(fd);
  }
}

export interface ScannedFile {
  /** Scope-relative path, for example `lessons/pnpm.md`. */
  path: string;
  mtimeMs: number;
  size: number;
}

export interface BrainRootOptions {
  /** A project brain comes from a repo: refuse files with other hard links, which could alias outside data. */
  refuseHardLinks?: boolean;
}

/**
 * Every filesystem touch of one brain root goes through here. The root is `<base>/<...parts>`
 * (`<home>/brain/global` or `<project>/.wooky/brain`). Each component from `base` down is
 * lstat-ed and a symbolic link anywhere, including `.wooky` or `brain` themselves, is refused:
 * a project brain comes with cloned repos and must not be able to point outside itself.
 */
export class BrainRoot {
  readonly base: string;
  private readonly parts: readonly string[];
  private readonly log: BrainLog;
  private readonly refuseHardLinks: boolean;
  private realBase: string | null = null;

  /** `base` must already be a real path; we never lstat it, only what is under it. */
  constructor(
    base: string,
    parts: readonly string[],
    log: BrainLog,
    options: BrainRootOptions = {},
  ) {
    this.base = base;
    this.parts = parts;
    this.log = log;
    this.refuseHardLinks = options.refuseHardLinks === true;
  }

  private absolute(segments: readonly string[]): string {
    return join(this.base, ...this.parts, ...segments);
  }

  private describe(segments: readonly string[]): string {
    return [...this.parts, ...segments].join("/");
  }

  private nativeBase(): string {
    return (this.realBase ??= realpathSync.native(this.base));
  }

  /**
   * lstat every component below base. Returns the final stat, or null when something is
   * missing. A symlink, or a file where a folder should be, is an error. On a filesystem that
   * ignores case, `hidden.md` also finds `Hidden.md`; a name whose on-disk spelling differs
   * from the one asked for is "missing" for a read and an error for a write.
   */
  inspect(
    segments: readonly string[],
    onCaseMismatch: "missing" | "refuse" = "missing",
  ): { abs: string; stat: Stats } | null {
    let current = this.base;
    let stat: Stats | null = null;
    const all = [...this.parts, ...segments];
    for (const [index, part] of all.entries()) {
      if (stat !== null && !stat.isDirectory()) {
        throw forbidden(`Brain path crosses a file: ${this.describe(segments)}`);
      }
      current = join(current, part);
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw forbidden(
          `Refusing a symbolic link in the brain path: ${all.slice(0, index + 1).join("/")}`,
        );
      }
    }
    if (stat === null) return null;
    const real = realpathSync.native(current);
    const realBase = this.nativeBase();
    if (!isInside(realBase, real)) {
      throw forbidden(`Brain path resolves outside its root: ${this.describe(segments)}`);
    }
    if (real.slice(realBase.length + 1) !== all.join(sep)) {
      if (onCaseMismatch === "refuse") {
        throw forbidden(
          `${this.describe(segments)} differs only in letter case from a file that exists`,
        );
      }
      return null;
    }
    return { abs: current, stat };
  }

  /** Reads a regular file without following links. Null when it does not exist. */
  read(segments: readonly string[]): RegularFile | null {
    const found = this.inspect(segments);
    if (found === null) return null;
    if (!found.stat.isFile()) {
      throw new ServiceError("bad_request", `${this.describe(segments)} is not a file`);
    }
    return readRegularFile(found.abs, this.describe(segments), {
      refuseHardLinks: this.refuseHardLinks,
    });
  }

  /** Creates the folder chain, one lstat-checked step at a time. */
  ensureDir(segments: readonly string[]): string {
    mkdirSync(this.base, { recursive: true });
    let current = this.base;
    for (const part of [...this.parts, ...segments]) {
      current = join(current, part);
      let stat: Stats;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if (!isMissing(error)) throw error;
        mkdirSync(current);
        stat = lstatSync(current);
      }
      if (stat.isSymbolicLink()) throw forbidden(`Refusing a symbolic link: ${current}`);
      if (!stat.isDirectory()) throw forbidden(`Brain folder is a file: ${current}`);
      if (basename(realpathSync.native(current)) !== part) {
        throw forbidden(`Brain folder differs only in letter case from one that exists: ${part}`);
      }
    }
    return current;
  }

  /** Temp file in the target's folder, then rename over it. */
  writeAtomic(dir: readonly string[], name: string, content: string): void {
    const dirAbs = this.ensureDir(dir);
    const existing = this.inspect([...dir, name], "refuse");
    if (existing !== null && !existing.stat.isFile()) {
      throw new ServiceError("bad_request", `${this.describe([...dir, name])} is not a file`);
    }
    const tmp = join(dirAbs, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, content, { flag: "wx", mode: 0o644 });
      renameSync(tmp, join(dirAbs, name));
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw error;
    }
  }

  /** Returns false when the file was not there. */
  unlink(segments: readonly string[]): boolean {
    const found = this.inspect(segments, "refuse");
    if (found === null) return false;
    if (!found.stat.isFile()) {
      throw new ServiceError("bad_request", `${this.describe(segments)} is not a file`);
    }
    unlinkSync(found.abs);
    return true;
  }

  /** Removes a folder only when it is empty. Never touches the root itself. */
  rmdirIfEmpty(segments: readonly string[]): void {
    if (segments.length === 0) return;
    const found = this.inspect(segments);
    if (found === null || !found.stat.isDirectory()) return;
    try {
      rmdirSync(found.abs);
    } catch {
      // not empty
    }
  }

  /**
   * Immediate children that are real folders or files, sorted. Symlinks are logged and left
   * out. Reads entries until the budget runs out and then stops, so a huge folder costs the
   * budget and no more.
   */
  children(segments: readonly string[], budget: ScanBudget = createScanBudget()): ChildList | null {
    const found = this.inspect(segments);
    if (found === null) return null;
    if (!found.stat.isDirectory()) return null;
    const entries: ChildList["entries"] = [];
    let complete = true;
    if (budget.stop?.() === true) {
      budget.remaining = 0;
      budget.truncated = true;
      return { entries, complete: false };
    }
    const dir = opendirSync(found.abs);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (budget.used % STOP_EVERY === STOP_EVERY - 1 && budget.stop?.() === true) {
          budget.remaining = 0;
          budget.truncated = true;
          complete = false;
          break;
        }
        if (budget.remaining <= 0) {
          if (!budget.truncated) {
            this.log(
              `brain: stopped reading ${this.describe([])} after ${budget.used} directory entries`,
            );
          }
          budget.truncated = true;
          complete = false;
          break;
        }
        budget.remaining -= 1;
        budget.used += 1;
        if (entry.isSymbolicLink()) {
          this.log(`brain: skipping symbolic link ${this.describe([...segments, entry.name])}`);
        } else if (entry.isDirectory()) entries.push({ name: entry.name, isDir: true });
        else if (entry.isFile()) entries.push({ name: entry.name, isDir: false });
      }
    } finally {
      dir.closeSync();
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { entries, complete };
  }

  /**
   * Whether there is at least one memory file anywhere in the brain. It stops at the first one,
   * so a brain of any size costs a few directory reads; `false` also when the budget ran out first.
   */
  hasMemory(budget: ScanBudget = createScanBudget()): boolean {
    const visit = (dir: readonly string[]): boolean => {
      const listing = this.children(dir, budget);
      if (listing === null) return false;
      for (const entry of listing.entries) {
        if (entry.name === BRAIN_OVERVIEW_FILE || !isBrainSegment(entry.name)) continue;
        if (!entry.isDir && entry.name.endsWith(".md")) return true;
      }
      for (const entry of listing.entries) {
        if (!entry.isDir || entry.name.endsWith(".md") || !isBrainSegment(entry.name)) continue;
        const next = [...dir, entry.name];
        if (next.length < BRAIN_MAX_SEGMENTS && visit(next)) return true;
      }
      return false;
    };
    return visit([]);
  }

  /**
   * Every memory file under a folder (default: the whole root), sorted by path. Overviews, odd
   * names and hard-linked files are left out. `truncated` is true when the walk stopped early:
   * the budget ran out or `maxFiles` was reached. `folders` holds each folder's memory count,
   * so one walk answers for every folder in the subtree.
   */
  scan(
    under: readonly string[] = [],
    budget: ScanBudget = createScanBudget(),
    maxFiles: number = Number.POSITIVE_INFINITY,
  ): ScanResult {
    const files: ScannedFile[] = [];
    const folders = new Map<string, number>([[under.join("/"), 0]]);
    let truncated = false;
    const visit = (dir: readonly string[]): void => {
      if (budget.remaining <= 0) {
        truncated = true;
        return;
      }
      const listing = this.children(dir, budget);
      if (listing === null) return;
      if (!listing.complete) truncated = true;
      for (const entry of listing.entries) {
        if (truncated && budget.remaining <= 0 && entry.isDir) return;
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        if (entry.name === BRAIN_OVERVIEW_FILE || !isBrainSegment(entry.name)) continue;
        const next = [...dir, entry.name];
        if (entry.isDir) {
          if (entry.name.endsWith(".md")) continue;
          folders.set(next.join("/"), 0);
          if (next.length < BRAIN_MAX_SEGMENTS) visit(next);
        } else if (entry.name.endsWith(".md")) {
          const stat = lstatSync(this.absolute(next));
          if (!stat.isFile()) continue;
          if (stat.size > MAX_FILE_BYTES) {
            this.log(`brain: skipping oversized file ${this.describe(next)}`);
            continue;
          }
          if (this.refuseHardLinks && stat.nlink > 1) {
            this.log(`brain: skipping hard-linked file ${this.describe(next)}`);
            continue;
          }
          files.push({ path: next.join("/"), mtimeMs: stat.mtimeMs, size: stat.size });
          for (let depth = under.length; depth < next.length; depth += 1) {
            const key = next.slice(0, depth).join("/");
            folders.set(key, (folders.get(key) ?? 0) + 1);
          }
        }
      }
    };
    visit(under);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, truncated, folders };
  }
}

const foldsCase = process.platform === "darwin" || process.platform === "win32";
const fold = (path: string) => (foldsCase ? path.toLowerCase() : path);

/** Where a scope's brain lives. Project roots come from the caller and are resolved once per call. */
export function openRoot(
  home: string,
  scope: BrainScope,
  resolveProjectRoot: (projectId: string) => string | null,
  log: BrainLog,
): BrainRoot {
  const realHome = realpathNearest(home);
  if (scope.kind === "global") return new BrainRoot(realHome, ["brain", "global"], log);
  const root = resolveProjectRoot(scope.projectId);
  if (root === null) throw new ServiceError("not_found", `Unknown project: ${scope.projectId}`);
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch (error) {
    if (isMissing(error)) throw new ServiceError("not_found", `Project folder is missing: ${root}`);
    throw error;
  }
  const projectBrain = fold(realpathNearest(join(realRoot, ".wooky", "brain")));
  const globalBrain = fold(join(realHome, "brain"));
  if (
    fold(realRoot) === fold(realHome) ||
    projectBrain === globalBrain ||
    isInside(projectBrain, globalBrain) ||
    isInside(globalBrain, projectBrain)
  ) {
    throw forbidden(
      "This project's brain overlaps Wooky's own data folder, so it is not used. Open a project folder that is not the home of WOOKY_HOME.",
    );
  }
  return new BrainRoot(realRoot, [".wooky", "brain"], log, { refuseHardLinks: true });
}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
