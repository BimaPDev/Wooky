import { z } from "zod";

/** Runtimes Wooky can drive. Wooky never ships its own model or account. */
export const ProviderKind = z.enum(["claude", "cursor", "codex", "demo", "opencode", "acp"]);
export type ProviderKind = z.infer<typeof ProviderKind>;
