import { join } from "node:path";
import { ZodError } from "zod";
import {
  BRAIN_MAX_MEMORIES,
  BRAIN_OVERVIEW_FILE,
  brainScopeKey,
  brainTrust,
  formatBrainUri,
  isBrainSegment,
  parseBrainPath,
  parseBrainUri,
  type BrainEntry,
  type BrainScope,
  type BrainSearchHit,
  type BrainTier,
  type BrainTreeNode,
  type MemoryFrontmatter,
  type MemoryFrontmatterInput,
} from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import {
  normalizeBody,
  parseFrontmatterInput,
  parseMemory,
  safeIso,
  serializeMemory,
  type ParsedMemory,
} from "./frontmatter.ts";
import {
  createScanBudget,
  openRoot,
  type BrainLog,
  type BrainRoot,
  type ScanBudget,
} from "./paths.ts";
import { assertBodySize, assertFrontmatterHasNoSecret, assertNoSecret } from "./safety.ts";
import {
  briefDatabaseError,
  isBusyDatabase,
  isCorruptDatabase,
  openBrainIndex,
  resetBrainIndexFiles,
  type BrainIndex,
  type IndexHit,
  type LoadedFile,
  type SyncReport,
} from "./search-index.ts";

export interface BrainStoreOptions {
  /** WOOKY_HOME. The global brain and the search index live under it. */
  home: string;
  /** The project's folder on this machine, or null when the id is unknown. */
  resolveProjectRoot: (projectId: string) => string | null;
  clock?: () => string;
  log?: BrainLog;
  /** Test hook: behave as if this SQLite had no FTS5. */
  noFts5?: boolean;
  now?: () => number;
  /** Test hook: how long the search index waits for another connection's lock. */
  indexBusyTimeoutMs?: number;
}

export interface BrainWriteInput {
  frontmatter: MemoryFrontmatterInput;
  body: string;
}

export interface BrainWriteResult {
  uri: string;
  updatedAt: string;
  created: boolean;
}

export interface BrainSearchOptions {
  scopes: readonly BrainScope[];
  pathPrefix?: string;
  limit: number;
  includeArchived?: boolean;
}

export interface BrainStore {
  /** One level of a folder, memories with their L0 and folders with their memory count. */
  list(dirUri: string, options?: { includeArchived?: boolean }): BrainTreeNode[];
  /**
   * A memory: tier 0 is its summary, tiers 1 and 2 add the body. A folder: tier 0 is the summary
   * of its overview, tiers 1 and 2 the overview (L1) itself.
   */
  read(uri: string, tier: BrainTier): BrainEntry;
  write(
    uri: string,
    input: BrainWriteInput,
    options?: { expectedUpdatedAt?: string },
  ): BrainWriteResult;
  archive(uri: string): BrainWriteResult;
  remove(uri: string): void;
  search(query: string, options: BrainSearchOptions): BrainSearchHit[];
  /** Active memories marked `pinned: true` in the given scopes, newest first. */
  pinned(scopes: readonly BrainScope[], limit: number): BrainSearchHit[];
  overview(dirUri: string): BrainEntry;
  /** Brings the search index in line with the files of one scope. */
  reindex(scope: BrainScope): SyncReport;
  close(): void;
}

/**
 * Directory entries a whole-brain walk may read. A valid brain holds at most BRAIN_MAX_MEMORIES
 * memories, an `_overview.md` for each folder (one folder per memory at worst) and those folders
 * themselves: three entries per memory. The headroom is for empty folders and stray files. A
 * hostile tree still costs a fixed amount.
 */
const WALK_ENTRIES = 3 * BRAIN_MAX_MEMORIES + 1000;
const walkBudget = () => createScanBudget(WALK_ENTRIES);

const AUTO_TAG = "auto";
const MAX_OVERVIEW_MEMORIES = 80;
const MAX_OVERVIEW_FOLDERS = 40;

interface Target {
  scope: BrainScope;
  path: string;
  segments: string[];
  isMemory: boolean;
  root: BrainRoot;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** "12 memories", or "12+ memories" when a listing's count stopped at its scan budget. */
const pluralCapped = (count: number, capped: boolean, one: string, many: string) =>
  `${count}${capped ? "+" : ""} ${count === 1 && !capped ? one : many}`;

/** A log-safe description of a failure: no Zod issue dump, no file contents, no raw message. */
function brief(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof ZodError) return "invalid value";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Failures the store knows how to describe from a code alone: Zod, filesystem (errno codes such as
 * `ENOENT`) and SQLite (a numeric `errcode`). Node's own `ERR_INVALID_ARG_TYPE` and friends are
 * not here: they report a programmer error, and one with no stack cannot be found.
 */
const ERRNO_CODE = /^E[A-Z0-9]+$/;
function isExpectedFailure(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  const { code, errcode } = (error ?? {}) as { code?: unknown; errcode?: unknown };
  return (typeof code === "string" && ERRNO_CODE.test(code)) || typeof errcode === "number";
}

export function createBrainStore(options: BrainStoreOptions): BrainStore {
  const clock = options.clock ?? (() => new Date().toISOString());
  const log: BrainLog = options.log ?? (() => {});
  let index: BrainIndex | null = null;
  const indexFile = join(options.home, "brain", "index.sqlite");

  /** Nothing but a ServiceError leaves the store: anything else is logged here and mapped. */
  function guard<T>(operation: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const detail = isBusyDatabase(error) ? briefDatabaseError(error) : brief(error);
      // A filesystem or SQLite error is understood from its code. Anything else is a bug, and
      // a bug with no stack cannot be found.
      const stack = isExpectedFailure(error) || !(error instanceof Error) ? "" : `\n${error.stack}`;
      log(`brain: ${operation} failed (${detail})${stack}`);
      throw new ServiceError(
        isBusyDatabase(error) ? "unavailable" : "internal",
        isBusyDatabase(error)
          ? "The brain search index is busy. Try again in a moment."
          : `Brain ${operation} failed.`,
      );
    }
  }

  const getIndex = (): BrainIndex =>
    (index ??= openBrainIndex(indexFile, {
      log,
      ...(options.noFts5 === undefined ? {} : { noFts5: options.noFts5 }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.indexBusyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.indexBusyTimeoutMs }),
    }));

  function target(uri: string): Target {
    const parsed = parseBrainUri(uri);
    if (parsed === null) {
      throw new ServiceError(
        "bad_request",
        "Not a valid brain URI. Use brain://global/<path> or brain://project/<id>/<path>; segments are lowercase a-z, 0-9, . _ - and at most 6 deep.",
      );
    }
    return {
      scope: parsed.scope,
      path: parsed.path,
      segments: parsed.segments,
      isMemory: parsed.segments.at(-1)?.endsWith(".md") ?? false,
      root: openRoot(options.home, parsed.scope, options.resolveProjectRoot, log),
    };
  }

  function memoryTarget(uri: string): Target {
    const found = target(uri);
    if (!found.isMemory) {
      throw new ServiceError(
        "bad_request",
        "A memory path ends in .md, for example lessons/pnpm.md",
      );
    }
    return found;
  }

  function readMemory(root: BrainRoot, segments: readonly string[]) {
    const file = root.read(segments);
    if (file === null) return null;
    const mtimeIso = safeIso(file.mtimeMs);
    return { ...file, parsed: parseMemory(file.raw.toString("utf8"), mtimeIso) };
  }

  function overviewFrontmatter(summary: string): MemoryFrontmatter {
    return {
      summary,
      kind: "note",
      tags: [AUTO_TAG],
      status: "active",
      updatedAt: clock(),
    };
  }

  /**
   * The deterministic L1 of a folder: each memory's summary and kind, each subfolder and its
   * count. `budget` bounds the folder's own listing; `folderCount` says how many memories a
   * subfolder holds.
   */
  function buildOverview(
    root: BrainRoot,
    segments: readonly string[],
    budget: ScanBudget,
    folderCount: (name: string) => { count: number; capped: boolean },
  ) {
    const memories: { name: string; summary: string; kind: string }[] = [];
    const folders: { name: string; count: number; capped: boolean }[] = [];
    const listing = root.children(segments, budget);
    for (const child of listing?.entries ?? []) {
      if (child.name === BRAIN_OVERVIEW_FILE || !isBrainSegment(child.name)) continue;
      if (child.isDir) {
        if (child.name.endsWith(".md")) continue;
        folders.push({ name: child.name, ...folderCount(child.name) });
      } else if (child.name.endsWith(".md")) {
        try {
          const found = readMemory(root, [...segments, child.name]);
          if (found !== null && found.parsed.frontmatter.status !== "archived") {
            memories.push({
              name: child.name,
              summary: found.parsed.frontmatter.summary,
              kind: found.parsed.frontmatter.kind,
            });
          }
        } catch (error) {
          log(`brain: leaving ${child.name} out of an overview (${brief(error)})`);
        }
      }
    }
    const lines = [segments.length === 0 ? "# Overview" : `# Overview: ${segments.join("/")}`];
    if (folders.length > 0) {
      lines.push("", "## Folders", "");
      for (const folder of folders.slice(0, MAX_OVERVIEW_FOLDERS)) {
        lines.push(
          `- \`${folder.name}/\` — ${pluralCapped(folder.count, folder.capped, "memory", "memories")}`,
        );
      }
      if (folders.length > MAX_OVERVIEW_FOLDERS) {
        lines.push(`- and ${folders.length - MAX_OVERVIEW_FOLDERS} more folders`);
      }
    }
    if (memories.length > 0) {
      lines.push("", "## Memories", "");
      for (const memory of memories.slice(0, MAX_OVERVIEW_MEMORIES)) {
        lines.push(`- \`${memory.name}\` (${memory.kind}): ${memory.summary}`);
      }
      if (memories.length > MAX_OVERVIEW_MEMORIES) {
        lines.push(`- and ${memories.length - MAX_OVERVIEW_MEMORIES} more memories`);
      }
    }
    if (folders.length === 0 && memories.length === 0) lines.push("", "No memories yet.");
    return {
      body: normalizeBody(lines.join("\n")),
      summary: `${plural(memories.length, "memory", "memories")}, ${plural(folders.length, "folder", "folders")}`,
      empty: folders.length === 0 && memories.length === 0,
      /** The folder itself had more entries than the budget allowed, so this listing is partial. */
      incomplete: listing !== null && !listing.complete,
    };
  }

  /**
   * Rewrites the `_overview.md` of a folder and of every folder above it, since their counts
   * changed too. An overview without the `auto` tag was written by a person or a model and is
   * left alone. The memory change already happened, so a failure here is logged, not thrown.
   *
   * The counts of every level come from one walk of the whole brain (the subtree under the
   * topmost folder being refreshed), so a refresh costs one tree, not one per level. If that walk
   * was cut short its counts are wrong, so every overview is left as it was.
   */
  function regenerateOverviews(root: BrainRoot, folder: readonly string[]): void {
    let counts: Map<string, number>;
    try {
      const walked = root.scan([], walkBudget());
      if (walked.truncated) {
        log("brain: left the overviews as they were (too many entries to count the memories)");
        return;
      }
      counts = walked.folders;
    } catch (error) {
      log(`brain: could not count memories for the overviews (${brief(error)})`);
      return;
    }
    const listings = createScanBudget();
    for (let depth = folder.length; depth >= 0; depth -= 1) {
      const segments = folder.slice(0, depth);
      try {
        if (root.inspect(segments) === null) continue;
        const existing = readMemory(root, [...segments, BRAIN_OVERVIEW_FILE]);
        if (existing !== null && !existing.parsed.frontmatter.tags.includes(AUTO_TAG)) continue;
        const built = buildOverview(root, segments, listings, (name) => ({
          count: counts.get([...segments, name].join("/")) ?? 0,
          capped: false,
        }));
        if (built.incomplete) {
          log(`brain: left the overview of /${segments.join("/")} as it was (folder too large)`);
          continue;
        }
        if (built.empty) {
          if (existing !== null) root.unlink([...segments, BRAIN_OVERVIEW_FILE]);
          root.rmdirIfEmpty(segments);
          continue;
        }
        if (existing !== null && existing.parsed.body === built.body) continue;
        root.writeAtomic(
          segments,
          BRAIN_OVERVIEW_FILE,
          serializeMemory(overviewFrontmatter(built.summary), built.body),
        );
      } catch (error) {
        log(`brain: could not refresh the overview of /${segments.join("/")} (${brief(error)})`);
      }
    }
  }

  function entry(
    found: Target,
    type: BrainEntry["type"],
    tier: BrainTier,
    parsed: Pick<ParsedMemory, "frontmatter" | "body">,
  ): BrainEntry {
    return {
      uri: formatBrainUri(found.scope, found.path),
      scope: found.scope,
      path: found.path,
      type,
      trust: brainTrust(found.scope),
      tier,
      frontmatter: parsed.frontmatter,
      body: tier === 0 ? "" : parsed.body,
    };
  }

  function overview(dirUri: string, tier: BrainTier = 1): BrainEntry {
    const found = target(dirUri);
    if (found.isMemory) {
      throw new ServiceError("bad_request", "An overview belongs to a folder, not a memory");
    }
    if (found.segments.length > 0 && found.root.inspect(found.segments) === null) {
      throw new ServiceError("not_found", `No such folder: ${dirUri}`);
    }
    const stored = readMemory(found.root, [...found.segments, BRAIN_OVERVIEW_FILE]);
    if (stored !== null) return entry(found, "overview", tier, stored.parsed);
    // Not stored yet: count each subfolder with one budget shared by the listing and its walks.
    const budget = createScanBudget();
    const built = buildOverview(found.root, found.segments, budget, (name) => {
      if (budget.remaining <= 0) return { count: 0, capped: true };
      const walked = found.root.scan([...found.segments, name], budget);
      return { count: walked.files.length, capped: walked.truncated };
    });
    return entry(found, "overview", tier, {
      frontmatter: overviewFrontmatter(built.summary),
      body: built.body,
    });
  }

  function commit(
    found: Target,
    frontmatter: MemoryFrontmatter,
    body: string,
    created: boolean,
  ): BrainWriteResult {
    const name = found.segments.at(-1) ?? "";
    const folder = found.segments.slice(0, -1);
    found.root.writeAtomic(folder, name, serializeMemory(frontmatter, body));
    regenerateOverviews(found.root, folder);
    return {
      uri: formatBrainUri(found.scope, found.path),
      updatedAt: frontmatter.updatedAt,
      created,
    };
  }

  /** Strictly after the previous stamp, so a second write in the same millisecond still differs. */
  function stamp(previous: string | undefined): string {
    const now = clock();
    if (previous === undefined || now > previous) return now;
    return new Date(Date.parse(previous) + 1).toISOString();
  }

  function loadForIndex(root: BrainRoot) {
    return (path: string): LoadedFile | null => {
      try {
        const found = readMemory(root, path.split("/"));
        if (found === null) return null;
        const { frontmatter, body } = found.parsed;
        return {
          raw: found.raw,
          doc: {
            summary: frontmatter.summary,
            kind: frontmatter.kind,
            tags: frontmatter.tags,
            status: frontmatter.status,
            pinned: frontmatter.pinned === true,
            updatedAt: frontmatter.updatedAt,
            body,
          },
        };
      } catch (error) {
        log(`brain: not indexing ${path} (${brief(error)})`);
        return null;
      }
    };
  }

  /** The index is only a cache: a damaged one is rebuilt from the files, once. */
  function withIndexRecovery<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (!isCorruptDatabase(error)) throw error;
      log(`brain: rebuilding the search index (${briefDatabaseError(error)})`);
      index?.close();
      index = null;
      resetBrainIndexFiles(indexFile);
      return run();
    }
  }

  function syncScope(scope: BrainScope, root: BrainRoot): SyncReport {
    let files: ReturnType<BrainRoot["scan"]>["files"] = [];
    let truncated = false;
    try {
      ({ files, truncated } = root.scan([], walkBudget()));
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      log(`brain: not indexing ${brainScopeKey(scope)} (${error.message})`);
    }
    const report = getIndex().sync(brainScopeKey(scope), files, loadForIndex(root));
    return truncated ? { ...report, truncated: true } : report;
  }

  /** Syncs each scope's files into the index; a scope that cannot be opened is skipped and logged. */
  function syncScopes(requested: readonly BrainScope[], what: string): Map<string, BrainScope> {
    const scopes = new Map<string, BrainScope>();
    for (const scope of requested) {
      const key = brainScopeKey(scope);
      if (scopes.has(key)) continue;
      try {
        const root = openRoot(options.home, scope, options.resolveProjectRoot, log);
        syncScope(scope, root);
        scopes.set(key, scope);
      } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        log(`brain: skipping ${key} in ${what} (${error.message})`);
      }
    }
    return scopes;
  }

  function toBrainHits(
    hits: readonly IndexHit[],
    scopes: ReadonlyMap<string, BrainScope>,
  ): BrainSearchHit[] {
    return hits.flatMap((hit) => {
      const scope = scopes.get(hit.scopeKey);
      if (scope === undefined) return [];
      return [
        {
          uri: formatBrainUri(scope, hit.path),
          scope,
          path: hit.path,
          trust: brainTrust(scope),
          summary: hit.summary,
          kind: hit.kind,
          tags: hit.tags,
          status: hit.status,
          updatedAt: hit.updatedAt,
          score: hit.score,
        },
      ];
    });
  }

  const raw: BrainStore = {
    list(dirUri, listOptions = {}) {
      const found = target(dirUri);
      if (found.isMemory) {
        throw new ServiceError("bad_request", "list takes a folder, not a memory");
      }
      const budget = createScanBudget();
      const listing = found.root.children(found.segments, budget);
      if (listing === null) {
        if (found.segments.length === 0) return [];
        throw new ServiceError("not_found", `No such folder: ${dirUri}`);
      }
      const trust = brainTrust(found.scope);
      const nodes: BrainTreeNode[] = [];
      for (const child of listing.entries) {
        if (child.name === BRAIN_OVERVIEW_FILE || !isBrainSegment(child.name)) continue;
        const childSegments = [...found.segments, child.name];
        const path = childSegments.join("/");
        const base = {
          uri: formatBrainUri(found.scope, path),
          scope: found.scope,
          path,
          name: child.name,
          trust,
        };
        if (child.isDir) {
          if (child.name.endsWith(".md")) continue;
          // Counts come from one walk that shares the listing's budget; a folder it could not
          // finish is marked capped instead of being walked again.
          if (budget.remaining <= 0) {
            nodes.push({ ...base, type: "folder", count: 0, capped: true });
          } else {
            const walked = found.root.scan(childSegments, budget);
            nodes.push({
              ...base,
              type: "folder",
              count: walked.files.length,
              ...(walked.truncated ? { capped: true } : {}),
            });
          }
        } else if (child.name.endsWith(".md")) {
          try {
            const memory = readMemory(found.root, childSegments);
            if (memory === null) continue;
            const { frontmatter } = memory.parsed;
            if (frontmatter.status === "archived" && listOptions.includeArchived !== true) continue;
            nodes.push({
              ...base,
              type: "memory",
              summary: frontmatter.summary,
              kind: frontmatter.kind,
              status: frontmatter.status,
              updatedAt: frontmatter.updatedAt,
            });
          } catch (error) {
            log(`brain: leaving ${path} out of a listing (${brief(error)})`);
          }
        }
      }
      return nodes;
    },

    read(uri, tier) {
      const found = target(uri);
      if (!found.isMemory) return overview(uri, tier);
      const memory = readMemory(found.root, found.segments);
      if (memory === null) throw new ServiceError("not_found", `No such memory: ${uri}`);
      return entry(found, "memory", tier, memory.parsed);
    },

    write(uri, input, writeOptions = {}) {
      const found = memoryTarget(uri);
      const now = clock();
      const body = normalizeBody(input.body);
      assertBodySize(body);
      // Before validation, so a rejected field cannot echo a credential back in an error.
      assertFrontmatterHasNoSecret(input.frontmatter);
      assertNoSecret(body, "body");
      const frontmatter = parseFrontmatterInput(input.frontmatter, now);

      const existing = readMemory(found.root, found.segments);
      const current = existing?.parsed.frontmatter.updatedAt;
      const expected = writeOptions.expectedUpdatedAt;
      if (expected !== undefined && current !== expected) {
        throw new ServiceError(
          "conflict",
          current === undefined
            ? `${uri} does not exist, so it cannot be updated from ${expected}`
            : `${uri} changed since ${expected} (now ${current}). Read it again and retry.`,
        );
      }
      // Its own budget: the overview refresh below walks the tree again with a fresh one.
      if (
        existing === null &&
        found.root.scan([], walkBudget(), BRAIN_MAX_MEMORIES).files.length >= BRAIN_MAX_MEMORIES
      ) {
        throw new ServiceError(
          "bad_request",
          `This brain already holds ${BRAIN_MAX_MEMORIES} memories. Archive or remove some first.`,
        );
      }
      return commit(found, { ...frontmatter, updatedAt: stamp(current) }, body, existing === null);
    },

    archive(uri) {
      const found = memoryTarget(uri);
      const memory = readMemory(found.root, found.segments);
      if (memory === null) throw new ServiceError("not_found", `No such memory: ${uri}`);
      const { frontmatter, body } = memory.parsed;
      if (frontmatter.status === "archived") {
        return { uri, updatedAt: frontmatter.updatedAt, created: false };
      }
      return commit(
        found,
        { ...frontmatter, status: "archived", updatedAt: stamp(frontmatter.updatedAt) },
        body,
        false,
      );
    },

    remove(uri) {
      const found = memoryTarget(uri);
      if (!found.root.unlink(found.segments)) {
        throw new ServiceError("not_found", `No such memory: ${uri}`);
      }
      regenerateOverviews(found.root, found.segments.slice(0, -1));
    },

    search(query, searchOptions) {
      if (
        searchOptions.pathPrefix !== undefined &&
        parseBrainPath(searchOptions.pathPrefix) === null
      ) {
        throw new ServiceError("bad_request", "pathPrefix is not a valid brain path");
      }
      const { hits, scopes } = withIndexRecovery(() => {
        const synced = syncScopes(searchOptions.scopes, "a search");
        const found = getIndex().search(query, {
          scopeKeys: [...synced.keys()],
          limit: searchOptions.limit,
          ...(searchOptions.pathPrefix === undefined
            ? {}
            : { pathPrefix: searchOptions.pathPrefix }),
          ...(searchOptions.includeArchived === undefined
            ? {}
            : { includeArchived: searchOptions.includeArchived }),
        });
        return { hits: found, scopes: synced };
      });
      return toBrainHits(hits, scopes);
    },

    pinned(pinnedScopes, limit) {
      const { hits, scopes } = withIndexRecovery(() => {
        const synced = syncScopes(pinnedScopes, "a pinned lookup");
        return { hits: getIndex().pinned([...synced.keys()], limit), scopes: synced };
      });
      return toBrainHits(hits, scopes);
    },

    overview: (dirUri) => overview(dirUri, 1),

    reindex(scope) {
      return withIndexRecovery(() =>
        syncScope(scope, openRoot(options.home, scope, options.resolveProjectRoot, log)),
      );
    },

    close() {
      index?.close();
      index = null;
    },
  };

  return {
    list: (dirUri, listOptions) => guard("list", () => raw.list(dirUri, listOptions)),
    read: (uri, tier) => guard("read", () => raw.read(uri, tier)),
    write: (uri, input, writeOptions) => guard("write", () => raw.write(uri, input, writeOptions)),
    archive: (uri) => guard("archive", () => raw.archive(uri)),
    remove: (uri) => guard("remove", () => raw.remove(uri)),
    search: (query, searchOptions) => guard("search", () => raw.search(query, searchOptions)),
    pinned: (scopes, limit) => guard("pinned", () => raw.pinned(scopes, limit)),
    overview: (dirUri) => guard("overview", () => raw.overview(dirUri)),
    reindex: (scope) => guard("reindex", () => raw.reindex(scope)),
    close: () => raw.close(),
  };
}
