/**
 * How many trailing chips do not fit in `budget` pixels. When any are hidden, room for the
 * overflow button is kept, so the visible chips plus that button always fit.
 */
export function countHiddenChips(
  widths: readonly number[],
  budget: number,
  gap: number,
  overflowWidth: number,
): number {
  const total = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
  if (total <= budget) return 0;
  let used = overflowWidth;
  let shown = 0;
  for (const width of widths) {
    const next = used + gap + width;
    if (next > budget) break;
    used = next;
    shown += 1;
  }
  return widths.length - shown;
}
