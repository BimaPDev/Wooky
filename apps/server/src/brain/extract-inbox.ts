import { parseBrainUri } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import {
  normalizeBody,
  parseFrontmatterInput,
  parseMemory,
  serializeMemory,
} from "./frontmatter.ts";
import { BrainRoot, createScanBudget, realpathNearest, type BrainLog } from "./paths.ts";
import { assertBodySize, assertFrontmatterHasNoSecret, assertNoSecret } from "./safety.ts";
import type { BrainWriteInput } from "./store.ts";

/**
 * Stand-in for B2's inbox: one Markdown memory per proposal under `<WOOKY_HOME>/brain/inbox/`,
 * at the path it would take in the global brain (`inbox/lessons/x.md` -> `global/lessons/x.md`),
 * with `status: proposed`. It goes through the same secret and shape checks as a store write,
 * never overwrites, and is capped. B2 replaces it behind `SubmitGlobalProposal`.
 */

export const INBOX_MAX_PROPOSALS = 200;

export interface FileInbox {
  submit(target: string, memory: BrainWriteInput): void;
  /** L0 of every proposal waiting, for the extractor's duplicate check. */
  summaries(): string[];
}

export function createFileInbox(options: {
  home: string;
  clock?: () => string;
  log?: BrainLog;
}): FileInbox {
  const clock = options.clock ?? (() => new Date().toISOString());
  const log = options.log ?? (() => {});
  const root = () => new BrainRoot(realpathNearest(options.home), ["brain", "inbox"], log);

  return {
    submit(target, memory) {
      const parsed = parseBrainUri(target);
      const name = parsed?.segments.at(-1);
      if (parsed === null || parsed.scope.kind !== "global" || !name?.endsWith(".md")) {
        throw new ServiceError(
          "bad_request",
          "An inbox proposal needs a brain://global/ memory URI",
        );
      }
      if (memory.frontmatter.status !== "proposed") {
        throw new ServiceError("bad_request", "An inbox proposal must have status proposed");
      }
      const body = normalizeBody(memory.body);
      assertBodySize(body);
      assertFrontmatterHasNoSecret(memory.frontmatter);
      assertNoSecret(body, "body");
      const frontmatter = parseFrontmatterInput(memory.frontmatter, clock());

      const inbox = root();
      const dir = parsed.segments.slice(0, -1);
      if (inbox.inspect(parsed.segments, "refuse") !== null) {
        throw new ServiceError("conflict", "A proposal for this path is already waiting");
      }
      if (
        inbox.scan([], createScanBudget(), INBOX_MAX_PROPOSALS).files.length >= INBOX_MAX_PROPOSALS
      ) {
        throw new ServiceError("bad_request", "The inbox is full. Review it first.");
      }
      inbox.writeAtomic(dir, name, serializeMemory(frontmatter, body));
    },

    summaries() {
      const inbox = root();
      const summaries: string[] = [];
      try {
        for (const file of inbox.scan([], createScanBudget(), INBOX_MAX_PROPOSALS).files) {
          const found = inbox.read(file.path.split("/"));
          if (found === null) continue;
          summaries.push(
            parseMemory(found.raw.toString("utf8"), new Date(found.mtimeMs).toISOString())
              .frontmatter.summary,
          );
        }
      } catch (error) {
        log(
          `brain: could not read the inbox (${error instanceof ServiceError ? error.message : "error"})`,
        );
      }
      return summaries;
    },
  };
}
