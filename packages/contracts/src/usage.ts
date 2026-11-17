import { z } from "zod";
import { IsoTime, ProviderKind } from "./model.ts";

export const LimitWindow = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nullable(),
  resetsAt: IsoTime.nullable(),
});
export type LimitWindow = z.infer<typeof LimitWindow>;

export const ProviderLimits = z.object({
  provider: ProviderKind,
  available: z.boolean(),
  plan: z.string().nullable(),
  windows: z.array(LimitWindow),
  checkedAt: IsoTime,
  problem: z.string().nullable(),
});
export type ProviderLimits = z.infer<typeof ProviderLimits>;
