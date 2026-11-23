import {
  formatBrainUri,
  parseBrainUri,
  type BrainEntry,
  type BrainInboxItem,
  type BrainInboxProposal,
  type BrainScope,
  type BrainSearchHit,
  type BrainTier,
  type BrainTreeNode,
  type BrainTrust,
  type MemoryFrontmatter,
} from "@wooky/contracts";
import { RpcCallError } from "../rpc/client.ts";

interface StoredMemory {
  uri: string;
  scope: BrainScope;
  path: string;
  frontmatter: MemoryFrontmatter;
  body: string;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function trustOf(scope: BrainScope, frontmatter?: Pick<MemoryFrontmatter, "source">): BrainTrust {
  if (scope.kind === "project") return "repo";
  const source = frontmatter?.source;
  if (
    source &&
    (source.threadId !== undefined ||
      source.agent !== undefined ||
      source.fleetRunId !== undefined ||
      source.turnId !== undefined)
  ) {
    return "repo";
  }
  return "user";
}

const memories = new Map<string, StoredMemory>([
  [
    "brain://global/preferences/pnpm.md",
    {
      uri: "brain://global/preferences/pnpm.md",
      scope: { kind: "global" },
      path: "preferences/pnpm.md",
      frontmatter: {
        summary: "Use pnpm, never npm; the lockfile is pnpm-lock.yaml",
        kind: "preference",
        tags: ["tooling", "pnpm"],
        status: "active",
        pinned: true,
        updatedAt: ago(240),
      },
      body: "Always run `pnpm` scripts in workspaces. Do not introduce `package-lock.json`.",
    },
  ],
  [
    "brain://global/lessons/vitest-timers.md",
    {
      uri: "brain://global/lessons/vitest-timers.md",
      scope: { kind: "global" },
      path: "lessons/vitest-timers.md",
      frontmatter: {
        summary: "Tests wait on events or fake timers, never wall-clock sleeps",
        kind: "lesson",
        tags: ["testing"],
        status: "active",
        updatedAt: ago(120),
      },
      body: "Use `vi.useFakeTimers()` or await specific promises instead of `setTimeout` sleeps.",
    },
  ],
  [
    "brain://project/p1/conventions/pagination.md",
    {
      uri: "brain://project/p1/conventions/pagination.md",
      scope: { kind: "project", projectId: "p1" },
      path: "conventions/pagination.md",
      frontmatter: {
        summary: "Use cursor-based pagination on orders endpoints",
        kind: "convention",
        tags: ["api", "db"],
        status: "active",
        updatedAt: ago(45),
        source: { threadId: "t1", agent: "claude", at: ago(45) },
      },
      body: "Pass `cursor` and `limit` (default 50) to `listOrders` instead of offset/limit.",
    },
  ],
]);

let proposals: BrainInboxProposal[] = [
  {
    id: "prop-1",
    targetUri: "brain://global/lessons/sqlite-busy.md",
    frontmatter: {
      summary: "Set busy_timeout before BEGIN IMMEDIATE on shared SQLite caches",
      kind: "gotcha",
      tags: ["sqlite"],
      status: "proposed",
      updatedAt: ago(15),
      source: { threadId: "t1", agent: "claude", at: ago(15) },
    },
    body: "Wait up to 2000ms for locks before failing with SQLITE_BUSY.",
    createdAt: ago(15),
    baseUpdatedAt: null,
  },
];

function listFolder(uri: string, includeArchived: boolean): BrainTreeNode[] {
  const parsed = parseBrainUri(uri);
  if (!parsed) throw new RpcCallError("bad_request", "Invalid brain URI.");
  const prefix = parsed.path ? `${parsed.path}/` : "";
  const folders = new Map<string, number>();
  const files: BrainTreeNode[] = [];

  for (const item of memories.values()) {
    if (
      item.scope.kind !== parsed.scope.kind ||
      (item.scope.kind === "project" &&
        parsed.scope.kind === "project" &&
        item.scope.projectId !== parsed.scope.projectId)
    ) {
      continue;
    }
    if (!item.path.startsWith(prefix)) continue;
    const rest = item.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      if (item.frontmatter.status === "archived" && !includeArchived) continue;
      files.push({
        uri: item.uri,
        scope: item.scope,
        path: item.path,
        name: rest,
        type: "memory",
        trust: trustOf(item.scope, item.frontmatter),
        summary: item.frontmatter.summary,
        kind: item.frontmatter.kind,
        status: item.frontmatter.status,
        updatedAt: item.frontmatter.updatedAt,
      });
    } else {
      const folderName = rest.slice(0, slash);
      if (item.frontmatter.status !== "archived" || includeArchived) {
        folders.set(folderName, (folders.get(folderName) ?? 0) + 1);
      }
    }
  }

  const folderNodes: BrainTreeNode[] = [...folders.entries()].map(([name, count]) => {
    const path = parsed.path ? `${parsed.path}/${name}` : name;
    return {
      uri: formatBrainUri(parsed.scope, path),
      scope: parsed.scope,
      path,
      name,
      type: "folder",
      trust: parsed.scope.kind === "global" ? "user" : "repo",
      count,
    };
  });
  return [...folderNodes, ...files];
}

export function brainRespond(method: string, params: unknown): unknown {
  if (!method.startsWith("brain.")) return undefined;
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "brain.list":
      return listFolder(String(p.uri ?? ""), p.includeArchived === true);
    case "brain.read": {
      const uri = String(p.uri ?? "");
      const tier = (p.tier ?? 2) as BrainTier;
      const item = memories.get(uri);
      if (item) {
        const entry: BrainEntry = {
          uri: item.uri,
          scope: item.scope,
          path: item.path,
          type: "memory",
          trust: trustOf(item.scope, item.frontmatter),
          tier,
          frontmatter: item.frontmatter,
          body: tier === 0 ? "" : item.body,
        };
        return entry;
      }
      const parsed = parseBrainUri(uri);
      if (parsed && !parsed.path.endsWith(".md")) {
        const children = listFolder(uri, false);
        const overview: BrainEntry = {
          uri,
          scope: parsed.scope,
          path: parsed.path,
          type: "overview",
          trust: parsed.scope.kind === "global" ? "user" : "repo",
          tier,
          frontmatter: {
            summary: `${children.length} entries`,
            kind: "note",
            tags: ["auto"],
            status: "active",
            updatedAt: new Date().toISOString(),
          },
          body:
            tier === 0
              ? ""
              : children
                  .map((child) =>
                    child.type === "folder"
                      ? `- \`${child.name}/\` (${child.count ?? 0})`
                      : `- \`${child.name}\`: ${child.summary ?? ""}`,
                  )
                  .join("\n") || "No memories yet.",
        };
        return overview;
      }
      throw new RpcCallError("not_found", `No such memory: ${uri}`);
    }
    case "brain.search": {
      const query = String(p.query ?? "").toLowerCase();
      const scopes = (p.scopes ?? []) as BrainScope[];
      const includeArchived = p.includeArchived === true;
      const hits: BrainSearchHit[] = [];
      for (const item of memories.values()) {
        if (item.frontmatter.status === "archived" && !includeArchived) continue;
        const matchesScope = scopes.some(
          (s) =>
            s.kind === item.scope.kind &&
            (s.kind === "global" ||
              (item.scope.kind === "project" && s.projectId === item.scope.projectId)),
        );
        if (!matchesScope) continue;
        const hay = `${item.frontmatter.summary} ${item.path} ${item.body}`.toLowerCase();
        if (!hay.includes(query)) continue;
        hits.push({
          uri: item.uri,
          scope: item.scope,
          path: item.path,
          trust: trustOf(item.scope, item.frontmatter),
          summary: item.frontmatter.summary,
          kind: item.frontmatter.kind,
          tags: item.frontmatter.tags,
          status: item.frontmatter.status,
          updatedAt: item.frontmatter.updatedAt,
          score: 1,
        });
      }
      return hits;
    }
    case "brain.write": {
      const uri = String(p.uri ?? "");
      const parsed = parseBrainUri(uri);
      if (!parsed || !parsed.path.endsWith(".md")) {
        throw new RpcCallError("bad_request", "Invalid memory URI.");
      }
      const existing = memories.get(uri);
      const expected = p.expectedUpdatedAt as string | null | undefined;
      if (expected === null && existing !== undefined) {
        throw new RpcCallError("conflict", `${uri} already exists.`);
      }
      if (typeof expected === "string" && existing?.frontmatter.updatedAt !== expected) {
        throw new RpcCallError("conflict", `${uri} changed since ${expected}.`);
      }
      const fm = p.frontmatter as Omit<MemoryFrontmatter, "updatedAt">;
      const updatedAt = new Date().toISOString();
      memories.set(uri, {
        uri,
        scope: parsed.scope,
        path: parsed.path,
        frontmatter: {
          ...fm,
          tags: fm.tags ?? [],
          status: fm.status ?? "active",
          updatedAt,
        },
        body: String(p.body ?? ""),
      });
      return { uri, updatedAt, created: !existing, queued: false };
    }
    case "brain.archive": {
      const uri = String(p.uri ?? "");
      const existing = memories.get(uri);
      if (!existing) throw new RpcCallError("not_found", `No such memory: ${uri}`);
      const updatedAt = new Date().toISOString();
      existing.frontmatter = { ...existing.frontmatter, status: "archived", updatedAt };
      return { uri, updatedAt, created: false };
    }
    case "brain.remove": {
      const uri = String(p.uri ?? "");
      if (!memories.delete(uri)) throw new RpcCallError("not_found", `No such memory: ${uri}`);
      return { ok: true };
    }
    case "brain.reindex":
      return { added: 0, updated: 0, removed: 0, unchanged: memories.size, scopes: 1 };
    case "brain.inbox.list":
      return proposals.map((proposal): BrainInboxItem => {
        const existing = memories.get(proposal.targetUri);
        return {
          ...proposal,
          overwrites: existing !== undefined,
          ...(existing ? { existingSummary: existing.frontmatter.summary } : {}),
          stale: (existing?.frontmatter.updatedAt ?? null) !== proposal.baseUpdatedAt,
        };
      });
    case "brain.inbox.approve": {
      const id = String(p.id ?? "");
      const found = proposals.find((item) => item.id === id);
      if (!found) throw new RpcCallError("not_found", `No such proposal: ${id}`);
      const existing = memories.get(found.targetUri);
      if ((existing?.frontmatter.updatedAt ?? null) !== found.baseUpdatedAt) {
        throw new RpcCallError("conflict", `${found.targetUri} changed since this proposal.`);
      }
      const edits = p.edits as
        { frontmatter: Omit<MemoryFrontmatter, "updatedAt">; body: string } | undefined;
      const parsed = parseBrainUri(found.targetUri);
      const updatedAt = new Date().toISOString();
      if (parsed) {
        const fm = edits
          ? {
              ...edits.frontmatter,
              tags: edits.frontmatter.tags ?? [],
              status: "active" as const,
              ...(edits.frontmatter.source === undefined && found.frontmatter.source
                ? { source: found.frontmatter.source }
                : {}),
              updatedAt,
            }
          : { ...found.frontmatter, status: "active" as const, updatedAt };
        memories.set(found.targetUri, {
          uri: found.targetUri,
          scope: parsed.scope,
          path: parsed.path,
          frontmatter: fm,
          body: edits ? edits.body : found.body,
        });
      }
      proposals = proposals.filter((item) => item.id !== id);
      return { id, uri: found.targetUri, updatedAt, created: !existing };
    }
    case "brain.inbox.reject": {
      const id = String(p.id ?? "");
      proposals = proposals.filter((item) => item.id !== id);
      return { id, ok: true };
    }
    default:
      return undefined;
  }
}
