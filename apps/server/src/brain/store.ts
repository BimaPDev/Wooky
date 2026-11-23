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
import { assertBodySize, assertNoSecret } from "./safety.ts";
import {
  briefDatabaseError,
  isBusyDatabase,
  isCorruptDatabase,
  openBrainIndex,
  resetBrainIndexFiles,
  type BrainIndex,
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
  overview(dirUri: string): BrainEntry;
  /** Brings the search index in line with the files of one scope. */
  reindex(scope: BrainScope): SyncReport;
  close(): void;
}

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
/** "12 memories", or "5000+ memories" when the count stopped at the scan budget. */
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
      log(`brain: ${operation} failed (${detail})`);
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

  /** The deterministic L1 of a folder: each memory's summary and kind, each subfolder and its count. */
  function buildOverview(root: BrainRoot, segments: readonly string[], budget: ScanBudget) {
    const memories: { name: string; summary: string; kind: string }[] = [];
    const folders: { name: string; count: number; capped: boolean }[] = [];
    const listing = root.children(segments, budget);
    for (const child of listing?.entries ?? []) {
      if (child.name === BRAIN_OVERVIEW_FILE || !isBrainSegment(child.name)) continue;
      if (child.isDir) {
        if (child.name.endsWith(".md")) continue;
        if (budget.remaining <= 0) {
          folders.push({ name: child.name, count: 0, capped: true });
        } else {
          const walked = root.scan([...segments, child.name], budget);
          folders.push({ name: child.name, count: walked.files.length, capped: walked.truncated });
        }
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
   */
  function regenerateOverviews(
    root: BrainRoot,
    folder: readonly string[],
    budget: ScanBudget,
  ): void {
    for (let depth = folder.length; depth >= 0; depth -= 1) {
      const segments = folder.slice(0, depth);
      try {
        if (root.inspect(segments) === null) continue;
        const existing = readMemory(root, [...segments, BRAIN_OVERVIEW_FILE]);
        if (existing !== null && !existing.parsed.frontmatter.tags.includes(AUTO_TAG)) continue;
        const built = buildOverview(root, segments, budget);
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
    const built = buildOverview(found.root, found.segments, createScanBudget());
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
    budget: ScanBudget,
  ): BrainWriteResult {
    const name = found.segments.at(-1) ?? "";
    const folder = found.segments.slice(0, -1);
    found.root.writeAtomic(folder, name, serializeMemory(frontmatter, body));
    regenerateOverviews(found.root, folder, budget);
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

  function syncScope(scope: BrainScope, root: BrainRoot): SyncReport {
    let files: ReturnType<BrainRoot["scan"]>["files"] = [];
    let truncated = false;
    try {
      ({ files, truncated } = root.scan([], createScanBudget()));
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      log(`brain: not indexing ${brainScopeKey(scope)} (${error.message})`);
    }
    const report = getIndex().sync(brainScopeKey(scope), files, loadForIndex(root));
    return truncated ? { ...report, truncated: true } : report;
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
      const budget = createScanBudget();
      if (
        existing === null &&
        found.root.scan([], budget, BRAIN_MAX_MEMORIES).files.length >= BRAIN_MAX_MEMORIES
      ) {
        throw new ServiceError(
          "bad_request",
          `This brain already holds ${BRAIN_MAX_MEMORIES} memories. Archive or remove some first.`,
        );
      }
      return commit(
        found,
        { ...frontmatter, updatedAt: stamp(current) },
        body,
        existing === null,
        budget,
      );
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
        createScanBudget(),
      );
    },

    remove(uri) {
      const found = memoryTarget(uri);
      if (!found.root.unlink(found.segments)) {
        throw new ServiceError("not_found", `No such memory: ${uri}`);
      }
      regenerateOverviews(found.root, found.segments.slice(0, -1), createScanBudget());
    },

    search(query, searchOptions) {
      if (
        searchOptions.pathPrefix !== undefined &&
        parseBrainPath(searchOptions.pathPrefix) === null
      ) {
        throw new ServiceError("bad_request", "pathPrefix is not a valid brain path");
      }
      const run = () => {
        const scopes = new Map<string, BrainScope>();
        for (const scope of searchOptions.scopes) {
          const key = brainScopeKey(scope);
          if (scopes.has(key)) continue;
          try {
            const root = openRoot(options.home, scope, options.resolveProjectRoot, log);
            syncScope(scope, root);
            scopes.set(key, scope);
          } catch (error) {
            if (!(error instanceof ServiceError)) throw error;
            log(`brain: skipping ${key} in a search (${error.message})`);
          }
        }
        const hits = getIndex().search(query, {
          scopeKeys: [...scopes.keys()],
          limit: searchOptions.limit,
          ...(searchOptions.pathPrefix === undefined
            ? {}
            : { pathPrefix: searchOptions.pathPrefix }),
          ...(searchOptions.includeArchived === undefined
            ? {}
            : { includeArchived: searchOptions.includeArchived }),
        });
        return { hits, scopes };
      };
      let outcome: ReturnType<typeof run>;
      try {
        outcome = run();
      } catch (error) {
        if (!isCorruptDatabase(error)) throw error;
        // The index is only a cache: a damaged one is rebuilt from the files, once.
        log(`brain: rebuilding the search index (${briefDatabaseError(error)})`);
        index?.close();
        index = null;
        resetBrainIndexFiles(indexFile);
        outcome = run();
      }
      const { hits, scopes } = outcome;
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
    },

    overview: (dirUri) => overview(dirUri, 1),

    reindex(scope) {
      return syncScope(scope, openRoot(options.home, scope, options.resolveProjectRoot, log));
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
    overview: (dirUri) => guard("overview", () => raw.overview(dirUri)),
    reindex: (scope) => guard("reindex", () => raw.reindex(scope)),
    close: () => raw.close(),
  };
}

const WRITABLE_FIELD_NAMES = new Set(["summary", "kind", "tags", "status", "pinned", "source"]);

/**
 * Scans every frontmatter key and value a writer sent, as it would be serialized. The error
 * names a known field, or just "frontmatter", never an unrecognized key.
 */
function assertFrontmatterHasNoSecret(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  for (const [key, value] of Object.entries(input)) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new ServiceError("bad_request", "frontmatter: a value cannot be serialized");
    }
    assertNoSecret(`${key}: ${json ?? ""}`, WRITABLE_FIELD_NAMES.has(key) ? key : "frontmatter");
  }
}
