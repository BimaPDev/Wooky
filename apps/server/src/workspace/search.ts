import type { ReadModel, WorkspaceEntry } from "@age/contracts";
import { ServiceError } from "../errors.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const CACHE_TTL_MS = 5_000;
const CACHE_MAX_CWDS = 32;

interface Indexed extends WorkspaceEntry {
  lower: string;
  base: string;
}

interface Listing {
  at: number;
  entries: Promise<Indexed[]>;
}

export interface WorkspaceSearch {
  search(params: { threadId: string; query: string; limit?: number }): Promise<WorkspaceEntry[]>;
}

export function createWorkspaceSearch(deps: {
  model: () => Pick<ReadModel, "threads" | "projects">;
  listFiles: (cwd: string) => Promise<string[]>;
  now?: () => number;
}): WorkspaceSearch {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Listing>();

  function entriesFor(cwd: string): Promise<Indexed[]> {
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < CACHE_TTL_MS) {
      cache.delete(cwd);
      cache.set(cwd, hit);
      return hit.entries;
    }
    const entries = deps.listFiles(cwd).then(buildIndex);
    const listing: Listing = { at: now(), entries };
    cache.delete(cwd);
    cache.set(cwd, listing);
    while (cache.size > CACHE_MAX_CWDS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    entries.catch(() => {
      if (cache.get(cwd) === listing) cache.delete(cwd);
    });
    return entries;
  }

  return {
    async search({ threadId, query, limit }) {
      const model = deps.model();
      const thread = model.threads[threadId];
      if (!thread) throw new ServiceError("not_found", `No thread with id ${threadId}.`);
      const cwd = thread.worktree?.path ?? model.projects[thread.projectId]?.root;
      if (!cwd) throw new ServiceError("not_found", `No project with id ${thread.projectId}.`);

      const max = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      let entries: Indexed[];
      try {
        entries = await entriesFor(cwd);
      } catch (error) {
        throw new ServiceError(
          "unavailable",
          `File search is not available: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const needle = query.trim().toLowerCase();
      const found = needle === "" ? topLevel(entries) : rank(entries, needle);
      return found.slice(0, max).map(({ path, kind }) => ({ path, kind }));
    },
  };
}

function safePath(raw: string): string | null {
  const path = raw.replaceAll("\\", "/");
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
  return path;
}

function buildIndex(files: string[]): Indexed[] {
  const seen = new Set<string>();
  const out: Indexed[] = [];
  const add = (path: string, kind: WorkspaceEntry["kind"]) => {
    const key = `${kind}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      path,
      kind,
      lower: path.toLowerCase(),
      base: path.slice(path.lastIndexOf("/") + 1).toLowerCase(),
    });
  };
  for (const raw of files) {
    const path = safePath(raw);
    if (!path) continue;
    let slash = path.indexOf("/");
    while (slash !== -1) {
      add(path.slice(0, slash), "dir");
      slash = path.indexOf("/", slash + 1);
    }
    add(path, "file");
  }
  return out;
}

function topLevel(entries: Indexed[]): Indexed[] {
  return entries
    .filter((entry) => !entry.path.includes("/"))
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : compare(a.lower, b.lower)));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at++;
    if (at === needle.length) return true;
  }
  return false;
}

/** 0 exact basename, 1 basename prefix, 2 basename substring, 3 path substring, 4 path subsequence. */
function tier(entry: Indexed, needle: string): number {
  if (entry.base === needle) return 0;
  if (entry.base.startsWith(needle)) return 1;
  if (entry.base.includes(needle)) return 2;
  if (entry.lower.includes(needle)) return 3;
  return isSubsequence(needle, entry.lower) ? 4 : -1;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rank(entries: Indexed[], needle: string): Indexed[] {
  const scored: { entry: Indexed; tier: number }[] = [];
  for (const entry of entries) {
    const t = tier(entry, needle);
    if (t >= 0) scored.push({ entry, tier: t });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.entry.path.length - b.entry.path.length ||
      compare(a.entry.lower, b.entry.lower),
  );
  return scored.map((item) => item.entry);
}
