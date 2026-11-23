import { z } from "zod";

/** Wooky Brain: Markdown memories addressed by `brain://` URIs. See docs/brain.md. */

export const BRAIN_SCHEME = "brain://";
/** File name of a folder's L1 overview. It never matches a segment, so no memory can take it. */
export const BRAIN_OVERVIEW_FILE = "_overview.md";
export const BRAIN_MAX_SEGMENTS = 6;
export const BRAIN_SUMMARY_MAX = 200;
export const BRAIN_BODY_MAX_BYTES = 16 * 1024;
export const BRAIN_MAX_MEMORIES = 2000;
export const BRAIN_INBOX_MAX = 200;
export const BRAIN_INBOX_MAX_PER_THREAD = 20;

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** One path component: lowercase, no leading dot, nothing a filesystem folds into something else. */
export function isBrainSegment(value: string): boolean {
  return (
    SEGMENT.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !WINDOWS_DEVICE.test(value)
  );
}

export function isBrainProjectId(value: string): boolean {
  return PROJECT_ID.test(value);
}

/**
 * Segments of a scope-relative path, or null when the path breaks a rule. "" is the scope root.
 * Only the last segment may end in `.md`: a path ending in `.md` names a memory, anything
 * else names a folder.
 */
export function parseBrainPath(path: string): string[] | null {
  if (path === "") return [];
  const segments = path.split("/");
  if (segments.length > BRAIN_MAX_SEGMENTS) return null;
  for (const [index, segment] of segments.entries()) {
    if (!isBrainSegment(segment)) return null;
    if (segment.endsWith(".md") && index < segments.length - 1) return null;
  }
  return segments;
}

export function isBrainMemoryPath(path: string): boolean {
  const segments = parseBrainPath(path);
  const last = segments?.at(-1);
  return last !== undefined && last.endsWith(".md");
}

export const BrainScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().refine(isBrainProjectId, { message: "Invalid project id" }),
  }),
]);
export type BrainScope = z.infer<typeof BrainScope>;

/** Where a memory came from: the user's own files, or a repo that may have been cloned from anyone. */
export const BrainTrust = z.enum(["user", "repo"]);
export type BrainTrust = z.infer<typeof BrainTrust>;

export function brainTrust(scope: BrainScope): BrainTrust {
  return scope.kind === "global" ? "user" : "repo";
}

export function brainScopeKey(scope: BrainScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

export interface ParsedBrainUri {
  scope: BrainScope;
  /** Scope-relative path, "" for the scope root. No leading or trailing slash. */
  path: string;
  segments: string[];
}

/** `brain://global/<path>` or `brain://project/<projectId>/<path>`. One trailing slash is allowed. */
export function parseBrainUri(uri: string): ParsedBrainUri | null {
  if (!uri.startsWith(BRAIN_SCHEME)) return null;
  const rest = uri.slice(BRAIN_SCHEME.length);
  const parts = rest.split("/");
  const kind = parts.shift();
  let scope: BrainScope;
  if (kind === "global") {
    scope = { kind: "global" };
  } else if (kind === "project") {
    const projectId = parts.shift();
    if (projectId === undefined || !isBrainProjectId(projectId)) return null;
    scope = { kind: "project", projectId };
  } else {
    return null;
  }
  if (parts.length > 0 && parts.at(-1) === "") parts.pop();
  const path = parts.join("/");
  const segments = parseBrainPath(path);
  return segments === null ? null : { scope, path, segments };
}

export function formatBrainUri(scope: BrainScope, path = ""): string {
  const base =
    scope.kind === "global"
      ? `${BRAIN_SCHEME}global/`
      : `${BRAIN_SCHEME}project/${scope.projectId}/`;
  return base + path;
}

export const BrainUri = z.string().refine((value) => parseBrainUri(value) !== null, {
  message: "Not a brain:// URI",
});
export type BrainUri = z.infer<typeof BrainUri>;

export const BrainKind = z.enum([
  "preference",
  "decision",
  "convention",
  "gotcha",
  "lesson",
  "playbook",
  "provider-note",
  "note",
]);
export type BrainKind = z.infer<typeof BrainKind>;

export const BrainStatus = z.enum(["active", "proposed", "archived"]);
export type BrainStatus = z.infer<typeof BrainStatus>;

export const BrainSource = z
  .object({
    threadId: z.string().min(1).max(128).optional(),
    turnId: z.string().min(1).max(128).optional(),
    fleetRunId: z.string().min(1).max(128).optional(),
    agent: z.string().min(1).max(64).optional(),
    at: z.iso.datetime().optional(),
  })
  .strict();
export type BrainSource = z.infer<typeof BrainSource>;

const BrainTag = z
  .string()
  .max(40)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, { message: "Tags are lowercase letters, digits and . _ : -" });

const frontmatterShape = {
  /** L0: one line, shown in listings and prompts. */
  summary: z
    .string()
    .min(1)
    .max(BRAIN_SUMMARY_MAX)
    .refine((value) => !/[\r\n]/.test(value), { message: "Summary must be a single line" }),
  kind: BrainKind,
  tags: z.array(BrainTag).max(12),
  status: BrainStatus,
  pinned: z.boolean().optional(),
  updatedAt: z.iso.datetime(),
  source: BrainSource.optional(),
};

export const MemoryFrontmatter = z.object(frontmatterShape).strict();
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatter>;

/** What a writer supplies. The store stamps `updatedAt`. */
export const MemoryFrontmatterInput = z
  .object({
    ...frontmatterShape,
    tags: frontmatterShape.tags.default([]),
    status: BrainStatus.default("active"),
  })
  .omit({ updatedAt: true })
  .strict();
export type MemoryFrontmatterInput = z.input<typeof MemoryFrontmatterInput>;

/** tier 0 is the summary, tier 1 a folder overview, tier 2 the full body. */
export const BrainTier = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type BrainTier = z.infer<typeof BrainTier>;

export const BrainEntry = z.object({
  uri: BrainUri,
  scope: BrainScope,
  path: z.string(),
  type: z.enum(["memory", "overview"]),
  trust: BrainTrust,
  tier: BrainTier,
  frontmatter: MemoryFrontmatter,
  /** Empty at tier 0. */
  body: z.string(),
});
export type BrainEntry = z.infer<typeof BrainEntry>;

export const BrainSearchHit = z.object({
  uri: BrainUri,
  scope: BrainScope,
  path: z.string(),
  trust: BrainTrust,
  summary: z.string(),
  kind: BrainKind,
  tags: z.array(z.string()),
  status: BrainStatus,
  updatedAt: z.string(),
  /** Higher is better. BM25, negated. */
  score: z.number(),
  source: BrainSource.optional(),
});
export type BrainSearchHit = z.infer<typeof BrainSearchHit>;

/** One level of a folder listing. Folders are listed lazily, so there is no recursion. */
export const BrainTreeNode = z.object({
  uri: BrainUri,
  scope: BrainScope,
  path: z.string(),
  name: z.string(),
  type: z.enum(["folder", "memory"]),
  trust: BrainTrust,
  /** Memories only. */
  summary: z.string().optional(),
  kind: BrainKind.optional(),
  status: BrainStatus.optional(),
  updatedAt: z.string().optional(),
  source: BrainSource.optional(),
  /** Folders only: memories below it, at any depth. */
  count: z.number().int().nonnegative().optional(),
  /** Folders only: the count stopped at the scan budget, so there are at least this many. */
  capped: z.boolean().optional(),
});
export type BrainTreeNode = z.infer<typeof BrainTreeNode>;

/**
 * Wire shape for `brain.write` frontmatter. Kept loose so unknown keys and overlong fields reach
 * the secret scan before strict validation rejects them without echoing values.
 */
export const BrainWriteFrontmatter = z.looseObject({
  summary: z.string(),
  kind: BrainKind,
  tags: z.array(z.string()).optional(),
  status: BrainStatus.optional(),
  pinned: z.boolean().optional(),
  source: z
    .looseObject({
      threadId: z.string().optional(),
      turnId: z.string().optional(),
      fleetRunId: z.string().optional(),
      agent: z.string().optional(),
      at: z.string().optional(),
    })
    .optional(),
});
export type BrainWriteFrontmatter = z.infer<typeof BrainWriteFrontmatter>;

/** A global memory proposed by an agent, waiting in `<WOOKY_HOME>/brain/inbox/` for approval. */
export const BrainInboxProposal = z.object({
  id: z.string().min(1),
  targetUri: BrainUri,
  frontmatter: MemoryFrontmatter,
  body: z.string(),
  createdAt: z.iso.datetime(),
  /** The target's `updatedAt` when this was proposed, or null when it did not exist. */
  baseUpdatedAt: z.string().nullable(),
  /** Set when the memory was written but the file could not be removed. The proposal is spent. */
  consumedAt: z.iso.datetime().optional(),
});
export type BrainInboxProposal = z.infer<typeof BrainInboxProposal>;

/** A proposal as listed: what approving it would do to the target as it is now. */
export const BrainInboxItem = BrainInboxProposal.extend({
  overwrites: z.boolean(),
  existingSummary: z.string().optional(),
  /** The target changed since the proposal was made, so approving it would be a conflict. */
  stale: z.boolean(),
});
export type BrainInboxItem = z.infer<typeof BrainInboxItem>;
