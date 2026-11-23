import { randomUUID } from "node:crypto";
import {
  BRAIN_INBOX_MAX,
  BrainInboxProposal,
  formatBrainUri,
  isBrainMemoryPath,
  parseBrainUri,
  type MemoryFrontmatter,
} from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { normalizeBody, parseFrontmatterInput } from "./frontmatter.ts";
import { BrainRoot, createScanBudget, realpathNearest, type BrainLog } from "./paths.ts";
import { assertBodySize, assertFrontmatterHasNoSecret, assertNoSecret } from "./safety.ts";
import type { BrainStore, BrainWriteResult } from "./store.ts";

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
  ): BrainInboxProposal;
  list(): BrainInboxProposal[];
  approve(id: string): BrainWriteResult & { id: string };
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

  return {
    propose(targetUri, input) {
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
        // Secret scan runs before schema validation, matching BrainStore.write.
        assertFrontmatterHasNoSecret(input.frontmatter);
        assertNoSecret(body, "body");
        const validated = parseFrontmatterInput(input.frontmatter, now);
        const frontmatter: MemoryFrontmatter = { ...validated, status: "proposed" };

        const root = openInboxRoot();
        const listing = root.children([], createScanBudget());
        const count =
          listing?.entries.filter((entry) => !entry.isDir && isProposalFile(entry.name)).length ??
          0;
        if (count >= BRAIN_INBOX_MAX) {
          throw new ServiceError(
            "conflict",
            `The brain inbox is full (${BRAIN_INBOX_MAX} proposals). Approve or reject some first.`,
          );
        }

        const id = assertValidId(newId());
        const proposal: BrainInboxProposal = {
          id,
          targetUri: formatBrainUri(target.scope, target.path),
          frontmatter,
          body,
          createdAt: now,
        };
        root.writeAtomic([], proposalFileName(id), `${JSON.stringify(proposal, null, 2)}\n`);
        return proposal;
      });
    },

    list() {
      return guard("list", () => {
        const root = openInboxRoot();
        const listing = root.children([], createScanBudget());
        if (listing === null) return [];
        const proposals: BrainInboxProposal[] = [];
        for (const entry of listing.entries) {
          if (entry.isDir || !isProposalFile(entry.name)) continue;
          try {
            const proposal = readProposalFile(root, entry.name);
            if (proposal !== null) proposals.push(proposal);
            else log(`brain inbox: skipping malformed proposal ${entry.name}`);
          } catch (error) {
            log(
              `brain inbox: skipping ${entry.name} (${error instanceof ServiceError ? error.message : "unreadable"})`,
            );
          }
        }
        proposals.sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        );
        return proposals;
      });
    },

    approve(id) {
      return guard("approve", () => {
        const safeId = assertValidId(id);
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
        const { updatedAt: _stampedOnWrite, ...frontmatterInput } = proposal.frontmatter;
        const written = options.store.write(proposal.targetUri, {
          frontmatter: { ...frontmatterInput, status: "active" },
          body: proposal.body,
        });
        root.unlink([fileName]);
        return { id: safeId, ...written };
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
