import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the built web UI lives relative to this package, never relative to the cwd.
 * A release bundle keeps it next to the server (`../web`); a source checkout builds it
 * into the sibling package (`apps/web/dist`). `moduleDir` is the directory of bin.ts.
 */
export function findWebDist(
  moduleDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = [join(moduleDir, "..", "web"), join(moduleDir, "..", "..", "web", "dist")];
  return candidates.find((candidate) => exists(join(candidate, "index.html"))) ?? null;
}
