// wooky-allow child-process: git ls-files for suggesting ignored shared worktree paths
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, realpath, symlink, link } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { isSharedRelPath, type SharedPath } from "@wooky/contracts";
import { gitChildEnv } from "../git/env.ts";

export type SharedPathAction = "linked" | "copied" | "skipped" | "refused";

export interface SharedPathResult {
  path: string;
  action: SharedPathAction;
  reason?: string;
}

export interface ApplySharedPathsResult {
  results: SharedPathResult[];
  linked: string[];
  copied: string[];
  skipped: string[];
}

function inside(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate === root || candidate.startsWith(prefix);
}

async function realOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function destParentReal(destRoot: string, dest: string): Promise<string | null> {
  let dir = dirname(dest);
  while (true) {
    try {
      return await realpath(dir);
    } catch {
      if (dir === destRoot || dir === dirname(dir)) return null;
      dir = dirname(dir);
    }
  }
}

export async function applySharedPaths(
  sourceRoot: string,
  destRoot: string,
  entries: readonly SharedPath[],
  platform: NodeJS.Platform = process.platform,
): Promise<ApplySharedPathsResult> {
  const sourceReal = await realpath(sourceRoot);
  const destReal = await realpath(destRoot);
  const results: SharedPathResult[] = [];

  for (const entry of entries) {
    // One bad entry must not take the rest of the setup down with it.
    try {
      results.push(await applyOne(sourceReal, destReal, entry, platform));
    } catch (error) {
      results.push({
        path: entry.path,
        action: "skipped",
        reason: error instanceof Error ? error.message : "could not be applied",
      });
    }
  }

  return {
    results,
    linked: results.filter((item) => item.action === "linked").map((item) => item.path),
    copied: results.filter((item) => item.action === "copied").map((item) => item.path),
    skipped: results
      .filter((item) => item.action === "skipped" || item.action === "refused")
      .map((item) => item.path),
  };
}

async function applyOne(
  sourceRoot: string,
  destRoot: string,
  entry: SharedPath,
  platform: NodeJS.Platform,
): Promise<SharedPathResult> {
  const rel = entry.path;
  if (!isSharedRelPath(rel)) {
    return { path: rel, action: "refused", reason: "path is not allowed in a worktree" };
  }
  const source = resolve(sourceRoot, rel);
  const dest = resolve(destRoot, rel);

  if (!inside(sourceRoot, source) || !inside(destRoot, dest)) {
    return { path: rel, action: "refused", reason: "path escapes the project" };
  }

  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch {
    return { path: rel, action: "skipped", reason: "source is missing" };
  }

  const sourceResolved = await realOrResolve(source);
  if (!inside(sourceRoot, sourceResolved)) {
    return { path: rel, action: "refused", reason: "source resolves outside the project" };
  }

  const destParent = await destParentReal(destRoot, dest);
  if (destParent && !inside(destRoot, destParent)) {
    return { path: rel, action: "refused", reason: "destination resolves outside the worktree" };
  }

  try {
    await lstat(dest);
    return { path: rel, action: "skipped", reason: "target already exists" };
  } catch {
    // dest is free
  }

  // Between the checks above and the write, a path component can be swapped for a symlink,
  // so both ends are resolved again immediately before anything is written.
  const recheck = async (): Promise<SharedPathResult | null> => {
    const sourceNow = await realOrResolve(source);
    if (!inside(sourceRoot, sourceNow)) {
      return { path: rel, action: "refused", reason: "source resolves outside the project" };
    }
    const parentNow = await destParentReal(destRoot, dest);
    if (parentNow && !inside(destRoot, parentNow)) {
      return { path: rel, action: "refused", reason: "destination resolves outside the worktree" };
    }
    return null;
  };

  const beforeMkdir = await recheck();
  if (beforeMkdir) return beforeMkdir;
  await mkdir(dirname(dest), { recursive: true });

  if (entry.mode === "copy") {
    const beforeCopy = await recheck();
    if (beforeCopy) return beforeCopy;
    await copyPreserveMode(source, dest, sourceStat.isDirectory());
    return { path: rel, action: "copied" };
  }

  const beforeLink = await recheck();
  if (beforeLink) return beforeLink;
  try {
    await linkEntry(source, dest, sourceStat.isDirectory(), platform);
    return { path: rel, action: "linked" };
  } catch {
    const beforeFallback = await recheck();
    if (beforeFallback) return beforeFallback;
    await copyPreserveMode(source, dest, sourceStat.isDirectory());
    return { path: rel, action: "copied", reason: "link failed, copied instead" };
  }
}

async function linkEntry(
  source: string,
  dest: string,
  isDir: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") {
    await symlink(source, dest);
    return;
  }
  if (isDir) {
    await symlink(source, dest, "junction");
    return;
  }
  await link(source, dest);
}

async function copyPreserveMode(source: string, dest: string, isDir: boolean): Promise<void> {
  await cp(source, dest, {
    recursive: isDir,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
}

/** Top-level gitignored entries in a project root. Missing git or a non-repo yields []. */
export async function suggestSharedPaths(projectRoot: string): Promise<string[]> {
  if (!existsSync(projectRoot)) return [];
  const stdout = await gitLsIgnored(projectRoot);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.replace(/[/\\]+$/, "").trim();
    if (!trimmed) continue;
    const top = trimmed.split(/[/\\]/)[0];
    if (!top || seen.has(top)) continue;
    if (top === ".git") continue;
    seen.add(top);
    out.push(top);
  }
  return out;
}

function gitLsIgnored(cwd: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { cwd, env: gitChildEnv(), windowsHide: true },
    );
    const out: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.on("error", () => resolvePromise(""));
    child.on("close", (code) => {
      resolvePromise(code === 0 ? Buffer.concat(out).toString("utf8") : "");
    });
  });
}
