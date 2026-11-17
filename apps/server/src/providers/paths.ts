import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

const realCache = new Map<string, string>();

function realpathOf(dir: string): string {
  let real = realCache.get(dir);
  if (real === undefined) {
    try {
      real = realpathSync(dir);
    } catch {
      real = dir;
    }
    realCache.set(dir, real);
  }
  return real;
}

function isOutsideWorkspace(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`);
}

/**
 * Path relative to the workspace when it lives inside it, otherwise unchanged.
 * Agents may report symlink-resolved paths (macOS /var → /private/var), so both
 * the given cwd and its real path are tried.
 */
export function workspaceRelative(path: string, cwd: string): string {
  if (!cwd || !isAbsolute(path)) return path;
  for (const base of new Set([cwd, realpathOf(cwd)])) {
    const rel = relative(base, path);
    if (rel === "") return ".";
    if (!isOutsideWorkspace(rel) && !isAbsolute(rel)) return rel;
  }
  return path;
}

/** Whether an absolute path lies inside a workspace directory (after realpath normalization). */
export function isInsideWorkspace(path: string, workspace: string): boolean {
  if (!workspace || !isAbsolute(path)) return false;
  const rel = workspaceRelative(path, workspace);
  if (rel === path) return false;
  return !isOutsideWorkspace(rel);
}
