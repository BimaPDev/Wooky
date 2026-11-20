import type { SyncConflict } from "@wooky/contracts";

/** "src/list.ts" → "src/list.theirs.ts", the name `both` gives the peer's copy. */
export function theirsPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const renamed = dot > 0 ? `${name.slice(0, dot)}.theirs${name.slice(dot)}` : `${name}.theirs`;
  return path.slice(0, slash + 1) + renamed;
}

interface Side {
  snapshotId: string;
  against: string | undefined;
  caption: string;
}

/**
 * What each column diffs. With a common ancestor both sides show their own changes since it.
 * Without one, each side shows how it differs from the other.
 */
export function conflictSides(conflict: SyncConflict): { mine: Side; theirs: Side } {
  if (conflict.base)
    return {
      mine: {
        snapshotId: conflict.mine,
        against: conflict.base,
        caption: "changes since the last sync",
      },
      theirs: {
        snapshotId: conflict.theirs,
        against: conflict.base,
        caption: "changes since the last sync",
      },
    };
  return {
    mine: { snapshotId: conflict.mine, against: conflict.theirs, caption: "compared with theirs" },
    theirs: { snapshotId: conflict.theirs, against: conflict.mine, caption: "compared with mine" },
  };
}
