import { randomUUID } from "node:crypto";
import {
  BRAIN_INBOX_MAX,
  BRAIN_INBOX_MAX_PER_THREAD,
  BrainInboxProposal,
  formatBrainUri,
  isBrainMemoryPath,
  parseBrainUri,
  type BrainInboxItem,
  type MemoryFrontmatter,
  type MemoryFrontmatterInput,
} from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { normalizeBody, parseFrontmatterInput } from "./frontmatter.ts";
import { BrainRoot, createScanBudget, realpathNearest, type BrainLog } from "./paths.ts";
import { assertBodySize, assertFrontmatterHasNoSecret, assertNoSecret } from "./safety.ts";
import type { BrainStore, BrainWriteResult } from "./store.ts";
import { sanitizeAgentFrontmatter } from "./trust.ts";

const PROPOSAL_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export interface BrainInboxOptions {
  home: string;
  store: BrainStore;
  clock?: () => string;
  log?: BrainLog;
  newId?: () => string;
}

export interface BrainInbox {
  propose(
    targetUri: string,
    input: { frontmatter: Record<string, unknown>; body: string },
    options?: { rejectExistingTarget?: boolean },
  ): BrainInboxProposal;
  list(): BrainInboxItem[];
  /** With `edits`, the user's version is validated and written in this one step. */
  approve(
    id: string,
    edits?: { frontmatter: Record<string, unknown>; body: string },
  ): BrainWriteResult & { id: string };
  reject(id: string): { id: string; ok: true };
}

function assertValidId(id: string): string {
  if (!PROPOSAL_ID.test(id)) {
    throw new ServiceError("bad_request", "Invalid proposal id.");
  }
  return id;
}

function isGlobalMemoryUri(uri: string): { canonical: string } | null {
  const parsed = parseBrainUri(uri);
  if (parsed === null || parsed.scope.kind !== "global" || !isBrainMemoryPath(parsed.path)) {
    return null;
  }
  return { canonical: formatBrainUri(parsed.scope, parsed.path) };
}

function proposalFileName(id: string): string {
  return `${id}.json`;
}

function isProposalFile(name: string): boolean {
  if (!name.endsWith(".json")) return false;
  return PROPOSAL_ID.test(name.slice(0, -".json".length));
}

export function createBrainInbox(options: BrainInboxOptions): BrainInbox {
  const clock = options.clock ?? (() => new Date().toISOString());
  const log: BrainLog = options.log ?? (() => {});
  const newId = options.newId ?? (() => `prop_${randomUUID()}`);

  /** Proposals whose memory was written but whose file could not be removed. Never re-applied. */
  const spent = new Map<string, BrainWriteResult & { id: string }>();

  const openInboxRoot = () => new BrainRoot(realpathNearest(options.home), ["brain", "inbox"], log);

  function guard<T>(operation: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      log(
        `brain inbox: ${operation} failed (${error instanceof Error ? error.name : "unknown error"})`,
      );
      throw new ServiceError("internal", `Brain inbox ${operation} failed.`);
    }
  }

  function readProposalFile(root: BrainRoot, fileName: string): BrainInboxProposal | null {
    const file = root.read([fileName]);
    if (file === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(file.raw.toString("utf8"));
    } catch {
      return null;
    }
    const parsed = BrainInboxProposal.safeParse(raw);
    if (!parsed.success) return null;
    if (isGlobalMemoryUri(parsed.data.targetUri) === null) return null;
    return parsed.data;
  }

  function proposalFiles(root: BrainRoot): string[] {
    const listing = root.children([], createScanBudget());
    if (listing === null) return [];
    return listing.entries
      .filter((entry) => !entry.isDir && isProposalFile(entry.name))
      .map((entry) => entry.name);
  }

  function currentTarget(uri: string): { updatedAt: string; summary: string } | null {
    try {
      const entry = options.store.read(uri, 0);
      return { updatedAt: entry.frontmatter.updatedAt, summary: entry.frontmatter.summary };
    } catch (error) {
      if (error instanceof ServiceError && error.code === "not_found") return null;
      throw error;
    }
  }

  /** The write succeeded. Remove the file; if that keeps failing, the proposal is spent anyway. */
  function consume(
    root: BrainRoot,
    fileName: string,
    proposal: BrainInboxProposal,
    result: BrainWriteResult & { id: string },
  ): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        root.unlink([fileName]);
        return;
      } catch {
        // retry once, then mark it spent
      }
    }
    spent.set(proposal.id, result);
    log(`brain inbox: could not remove approved proposal ${proposal.id}; marked as spent`);
    try {
      const marked: BrainInboxProposal = { ...proposal, consumedAt: clock() };
      root.writeAtomic([], fileName, `${JSON.stringify(marked, null, 2)}\n`);
    } catch {
      // the in-memory mark and the base-stamp condition still stop a second approval
    }
  }

  return {
    propose(targetUri, input, proposeOptions = {}) {
      return guard("propose", () => {
        const target = parseBrainUri(targetUri);
        if (target === null) {
          throw new ServiceError(
            "bad_request",
            "Not a valid brain URI. Use brain://global/<path>; segments are lowercase a-z, 0-9, . _ - and at most 6 deep.",
          );
        }
        if (target.scope.kind !== "global") {
          throw new ServiceError("bad_request", "Only global memories can be queued in the inbox.");
        }
        if (!isBrainMemoryPath(target.path)) {
          throw new ServiceError(
            "bad_request",
            "A memory path ends in .md, for example lessons/pnpm.md",
          );
        }

        const now = clock();
        const body = normalizeBody(input.body);
        assertBodySize(body);
        const agentFields = sanitizeAgentFrontmatter(input.frontmatter);
        // Secret scan runs before schema validation, matching BrainStore.write.
        assertFrontmatterHasNoSecret(agentFields);
        assertNoSecret(body, "body");
        const validated = parseFrontmatterInput(agentFields, now);
        const frontmatter: MemoryFrontmatter = { ...validated, status: "proposed" };
        const targetCanonical = formatBrainUri(target.scope, target.path);
        const proposer = frontmatter.source?.threadId ?? null;

        const root = openInboxRoot();
        const files = proposalFiles(root);
        const replaced: string[] = [];
        let fromThread = 0;
        for (const name of files) {
          let existing: BrainInboxProposal | null = null;
          try {
            existing = readProposalFile(root, name);
          } catch {
            existing = null;
          }
          if (existing === null || existing.consumedAt !== undefined) continue;
          if (proposeOptions.rejectExistingTarget && existing.targetUri === targetCanonical) {
            throw new ServiceError(
              "conflict",
              `A proposal for ${targetCanonical} is already waiting in the brain inbox.`,
            );
          }
          if ((existing.frontmatter.source?.threadId ?? null) !== proposer) continue;
          if (existing.targetUri === targetCanonical) replaced.push(name);
          else fromThread += 1;
        }
        if (fromThread >= BRAIN_INBOX_MAX_PER_THREAD) {
          throw new ServiceError(
            "conflict",
            `This thread already has ${BRAIN_INBOX_MAX_PER_THREAD} proposals waiting in the brain inbox. Wait for the user to review them.`,
          );
        }
        if (files.length - replaced.length >= BRAIN_INBOX_MAX) {
          throw new ServiceError(
            "conflict",
            `The brain inbox is full (${BRAIN_INBOX_MAX} proposals). Approve or reject some first.`,
          );
        }
        const baseUpdatedAt = currentTarget(targetCanonical)?.updatedAt ?? null;

        const id = assertValidId(newId());
        const proposal: BrainInboxProposal = {
          id,
          targetUri: targetCanonical,
          frontmatter,
          body,
          createdAt: now,
          baseUpdatedAt,
        };
        root.writeAtomic([], proposalFileName(id), `${JSON.stringify(proposal, null, 2)}\n`);
        for (const name of replaced) {
          try {
            root.unlink([name]);
          } catch {
            log(`brain inbox: could not remove replaced proposal ${name}`);
          }
        }
        return proposal;
      });
    },

    list() {
      return guard("list", () => {
        const root = openInboxRoot();
        const items: BrainInboxItem[] = [];
        for (const name of proposalFiles(root)) {
          try {
            const proposal = readProposalFile(root, name);
            if (proposal === null) {
              log(`brain inbox: skipping malformed proposal ${name}`);
              continue;
            }
            if (proposal.consumedAt !== undefined || spent.has(proposal.id)) continue;
            let existing: { updatedAt: string; summary: string } | null = null;
            try {
              existing = currentTarget(proposal.targetUri);
            } catch {
              log(`brain inbox: could not read the target of ${proposal.id}`);
            }
            items.push({
              ...proposal,
              overwrites: existing !== null,
              ...(existing !== null ? { existingSummary: existing.summary } : {}),
              stale: (existing?.updatedAt ?? null) !== proposal.baseUpdatedAt,
            });
          } catch (error) {
            log(
              `brain inbox: skipping ${name} (${error instanceof ServiceError ? error.message : "unreadable"})`,
            );
          }
        }
        items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        return items;
      });
    },

    approve(id, edits) {
      return guard("approve", () => {
        const safeId = assertValidId(id);
        const already = spent.get(safeId);
        if (already !== undefined) return already;
        const root = openInboxRoot();
        const fileName = proposalFileName(safeId);
        const file = root.read([fileName]);
        if (file === null) {
          throw new ServiceError("not_found", `No brain proposal with id ${safeId}.`);
        }
        let raw: unknown;
        try {
          raw = JSON.parse(file.raw.toString("utf8"));
        } catch {
          throw new ServiceError("bad_request", `Proposal ${safeId} is malformed.`);
        }
        const parsed = BrainInboxProposal.safeParse(raw);
        if (!parsed.success || isGlobalMemoryUri(parsed.data.targetUri) === null) {
          throw new ServiceError("bad_request", `Proposal ${safeId} is malformed.`);
        }
        const proposal = parsed.data;
        if (proposal.consumedAt !== undefined) {
          try {
            root.unlink([fileName]);
          } catch {
            // still stuck; it stays hidden and is never applied
          }
          throw new ServiceError("not_found", `Proposal ${safeId} was already approved.`);
        }
        const { updatedAt: _stampedOnWrite, ...proposed } = proposal.frontmatter;
        // An edit that drops `source` keeps the proposal's: the text still began as an agent's.
        const frontmatter = edits
          ? {
              ...edits.frontmatter,
              ...(edits.frontmatter.source === undefined && proposal.frontmatter.source
                ? { source: proposal.frontmatter.source }
                : {}),
            }
          : proposed;
        const written = options.store.write(
          proposal.targetUri,
          {
            frontmatter: { ...frontmatter, status: "active" } as MemoryFrontmatterInput,
            body: edits ? edits.body : proposal.body,
          },
          { expectedUpdatedAt: proposal.baseUpdatedAt },
        );
        const result = { id: safeId, ...written };
        consume(root, fileName, proposal, result);
        return result;
      });
    },

    reject(id) {
      return guard("reject", () => {
        const safeId = assertValidId(id);
        const root = openInboxRoot();
        if (!root.unlink([proposalFileName(safeId)])) {
          throw new ServiceError("not_found", `No brain proposal with id ${safeId}.`);
        }
        return { id: safeId, ok: true as const };
      });
    },
  };
}
