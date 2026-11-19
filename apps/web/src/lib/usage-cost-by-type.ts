import type { UsageCostByType } from "@wooky/contracts";

export type CostShareSegment = {
  key: keyof UsageCostByType;
  label: string;
  value: number;
};

const LABELS: Record<keyof UsageCostByType, string> = {
  input: "Input",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  output: "Output",
  other: "Other",
};

export const OTHER_SEGMENT_MIN_USD = 0.005;

export function sumCostByType(rows: readonly UsageCostByType[]): UsageCostByType {
  const out: UsageCostByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 };
  for (const row of rows) {
    out.input += row.input;
    out.cacheRead += row.cacheRead;
    out.cacheWrite += row.cacheWrite;
    out.output += row.output;
    out.other += row.other;
  }
  return out;
}

export function visibleCostSegments(
  totals: UsageCostByType,
  minOtherUsd: number = OTHER_SEGMENT_MIN_USD,
): CostShareSegment[] {
  const segments: CostShareSegment[] = [];
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "other"] as const) {
    const value = totals[key];
    if (key === "other" && value < minOtherUsd) continue;
    if (value > 0) segments.push({ key, label: LABELS[key], value });
  }
  return segments;
}
