import { z } from "zod";

export const TurnFailureKind = z.enum(["rate_limit", "quota", "overloaded", "auth", "other"]);
export type TurnFailureKind = z.infer<typeof TurnFailureKind>;

const IsoTime = z.string();

export const TurnFailure = z.object({
  kind: TurnFailureKind,
  resetAt: IsoTime.optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  message: z.string().max(2000),
});
export type TurnFailure = z.infer<typeof TurnFailure>;

export const ModelTarget = z.object({
  provider: z.enum(["claude", "cursor", "codex", "demo"]),
  model: z.string().min(1),
});
export type ModelTarget = z.infer<typeof ModelTarget>;

export const ThreadFailoverState = z.object({
  original: ModelTarget,
  switchedAt: IsoTime,
  reason: TurnFailureKind,
  resetAt: IsoTime.optional(),
  switches: z.number().int(),
});
export type ThreadFailoverState = z.infer<typeof ThreadFailoverState>;

export const ProviderCooldown = z.object({
  until: IsoTime,
  reason: TurnFailureKind,
});
export type ProviderCooldown = z.infer<typeof ProviderCooldown>;

export const FailoverSettings = z
  .object({
    enabled: z.boolean().default(true),
    chain: z.array(ModelTarget).max(12).default([]),
    maxSwitchesPerPrompt: z.number().int().min(1).max(6).default(3),
    switchBack: z.boolean().default(true),
    triggers: z
      .array(z.enum(["rate_limit", "quota", "overloaded"]))
      .default(["rate_limit", "quota", "overloaded"]),
  })
  .default({
    enabled: true,
    chain: [],
    maxSwitchesPerPrompt: 3,
    switchBack: true,
    triggers: ["rate_limit", "quota", "overloaded"],
  });
export type FailoverSettings = z.infer<typeof FailoverSettings>;
