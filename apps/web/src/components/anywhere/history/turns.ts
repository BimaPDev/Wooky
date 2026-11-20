/**
 * Snapshots name their thread but not the turn. A turn snapshot is taken as the turn finishes, so
 * the turn is the last one that ended at or before it. Returns its index, or -1.
 */
export function turnForSnapshot(
  turns: readonly { id: string; endedAt: string | null }[],
  createdAt: string,
): number {
  const at = Date.parse(createdAt);
  let best = -1;
  turns.forEach((turn, index) => {
    if (turn.endedAt && Date.parse(turn.endedAt) <= at + 2_000) best = index;
  });
  return best;
}
