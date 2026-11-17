const BOUNDARY = /[\s/\-_.:]/;

/**
 * Best subsequence alignment, case-insensitive. Higher is better; null means no match.
 * Rewards consecutive runs and word starts, penalises gaps.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  const start = (j: number) => (j === 0 || BOUNDARY.test(t[j - 1] ?? " ") ? 8 : 0);
  let prev: number[] = [];
  for (let i = 0; i < q.length; i++) {
    const row: number[] = Array.from({ length: t.length }, () => -Infinity);
    for (let j = i; j < t.length; j++) {
      if (t[j] !== q[i]) continue;
      if (i === 0) {
        row[j] = start(j) - Math.min(j, 6);
        continue;
      }
      let best = -Infinity;
      for (let k = i - 1; k < j; k++) {
        const from = prev[k] ?? -Infinity;
        if (from === -Infinity) continue;
        const gain = k === j - 1 ? 5 : start(j) - Math.min(j - k - 1, 6);
        best = Math.max(best, from + gain);
      }
      row[j] = best;
    }
    prev = row;
  }
  const score = Math.max(...prev);
  if (score === -Infinity) return null;
  return score + (t.startsWith(q) ? 10 : 0) - t.length * 0.01;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return items.slice();
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(query, text(item));
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}
