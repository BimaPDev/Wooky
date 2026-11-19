import { z } from "zod";

/** Runtimes AGE can drive. AGE never ships its own model or account. */
export const ProviderKind = z.enum(["claude", "cursor", "codex", "demo", "opencode", "acp"]);
export type ProviderKind = z.infer<typeof ProviderKind>;
