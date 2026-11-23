import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve, sep } from "node:path";
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

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function forbidden(message: string): ServiceError {
  return new ServiceError("forbidden", message);
}

export interface ScannedFile {
  /** Scope-relative path, for example `lessons/pnpm.md`. */
  path: string;
  mtimeMs: number;
  size: number;
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

  /** `base` must already be a real path; we never lstat it, only what is under it. */
  constructor(base: string, parts: readonly string[], log: BrainLog) {
    this.base = base;
    this.parts = parts;
    this.log = log;
  }

  private absolute(segments: readonly string[]): string {
    return join(this.base, ...this.parts, ...segments);
  }

  private describe(segments: readonly string[]): string {
    return [...this.parts, ...segments].join("/");
  }

  /**
   * lstat every component below base. Returns the final stat, or null when something is
   * missing. A symlink, or a file where a folder should be, is an error.
   */
  inspect(segments: readonly string[]): { abs: string; stat: Stats } | null {
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
    if (!isInside(this.base, realpathSync(current))) {
      throw forbidden(`Brain path resolves outside its root: ${this.describe(segments)}`);
    }
    return { abs: current, stat };
  }

  /** Reads a regular file without following links. Null when it does not exist. */
  read(segments: readonly string[]): { raw: Buffer; mtimeMs: number; size: number } | null {
    const found = this.inspect(segments);
    if (found === null) return null;
    if (!found.stat.isFile()) {
      throw new ServiceError("bad_request", `${this.describe(segments)} is not a file`);
    }
    const fd = openSync(found.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw forbidden(`${this.describe(segments)} is not a regular file`);
      if (stat.size > MAX_FILE_BYTES) {
        throw new ServiceError(
          "bad_request",
          `${this.describe(segments)} is ${stat.size} bytes; brain files over ${MAX_FILE_BYTES} are not read`,
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
    }
    return current;
  }

  /** Temp file in the target's folder, then rename over it. */
  writeAtomic(dir: readonly string[], name: string, content: string): void {
    const dirAbs = this.ensureDir(dir);
    const existing = this.inspect([...dir, name]);
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
    const found = this.inspect(segments);
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

  /** Immediate children that are real folders or files. Symlinks are logged and left out. */
  children(segments: readonly string[]): { name: string; isDir: boolean }[] | null {
    const found = this.inspect(segments);
    if (found === null) return null;
    if (!found.stat.isDirectory()) return null;
    const result: { name: string; isDir: boolean }[] = [];
    for (const entry of readdirSync(found.abs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        this.log(`brain: skipping symbolic link ${this.describe([...segments, entry.name])}`);
        continue;
      }
      if (entry.isDirectory()) result.push({ name: entry.name, isDir: true });
      else if (entry.isFile()) result.push({ name: entry.name, isDir: false });
    }
    return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Every memory file under a folder (default: the whole root), sorted by path. Overviews and odd names are left out. */
  scan(under: readonly string[] = []): { files: ScannedFile[]; truncated: boolean } {
    const files: ScannedFile[] = [];
    let seen = 0;
    let truncated = false;
    const visit = (dir: readonly string[]): void => {
      const entries = this.children(dir);
      if (entries === null) return;
      for (const entry of entries) {
        if (truncated) return;
        seen += 1;
        if (seen > MAX_SCAN_ENTRIES) {
          truncated = true;
          this.log(
            `brain: stopped scanning ${this.describe([])} after ${MAX_SCAN_ENTRIES} entries`,
          );
          return;
        }
        if (entry.name === BRAIN_OVERVIEW_FILE || !isBrainSegment(entry.name)) continue;
        const next = [...dir, entry.name];
        if (entry.isDir) {
          if (!entry.name.endsWith(".md") && next.length < BRAIN_MAX_SEGMENTS) visit(next);
        } else if (entry.name.endsWith(".md")) {
          const stat = lstatSync(this.absolute(next));
          if (!stat.isFile()) continue;
          if (stat.size > MAX_FILE_BYTES) {
            this.log(`brain: skipping oversized file ${this.describe(next)}`);
            continue;
          }
          files.push({ path: next.join("/"), mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    };
    visit(under);
    return { files, truncated };
  }
}

/** Where a scope's brain lives. Project roots come from the caller and are resolved once per call. */
export function openRoot(
  home: string,
  scope: BrainScope,
  resolveProjectRoot: (projectId: string) => string | null,
  log: BrainLog,
): BrainRoot {
  if (scope.kind === "global") {
    let base = resolve(home);
    try {
      base = realpathSync(base);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return new BrainRoot(base, ["brain", "global"], log);
  }
  const root = resolveProjectRoot(scope.projectId);
  if (root === null) throw new ServiceError("not_found", `Unknown project: ${scope.projectId}`);
  try {
    return new BrainRoot(realpathSync(root), [".wooky", "brain"], log);
  } catch (error) {
    if (isMissing(error)) throw new ServiceError("not_found", `Project folder is missing: ${root}`);
    throw error;
  }
}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
