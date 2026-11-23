import type { BrainTrust, MemoryFrontmatter } from "@wooky/contracts";

/**
 * True when the memory says an agent wrote it. `source` is stamped by the server on every agent
 * write and carried through approval, so a global memory an agent proposed and the user approved
 * is still agent-authored. A person's own file has no `source`.
 */
export function isAgentAuthored(frontmatter: Pick<MemoryFrontmatter, "source">): boolean {
  const source = frontmatter.source;
  if (source === undefined) return false;
  return (
    source.threadId !== undefined ||
    source.agent !== undefined ||
    source.fleetRunId !== undefined ||
    source.turnId !== undefined
  );
}

/**
 * The trust a reader must apply: `repo` (untrusted data, fenced) for project memories and for any
 * agent-authored memory, even in the global scope. B3's context builder and the MCP tools call this
 * instead of reading `trust` alone.
 */
export function effectiveTrust(entry: {
  trust: BrainTrust;
  frontmatter: Pick<MemoryFrontmatter, "source">;
}): BrainTrust {
  return entry.trust === "repo" || isAgentAuthored(entry.frontmatter) ? "repo" : "user";
}

/** Fields only the user may set. Dropped from every agent write and proposal. */
export function sanitizeAgentFrontmatter<T extends Record<string, unknown>>(
  frontmatter: T,
): Omit<T, "pinned"> {
  const { pinned: _pinned, ...rest } = frontmatter;
  return rest;
}
