import { createClaudeAdapter } from "./claude/adapter.ts";
import { createCursorAdapter } from "./cursor/adapter.ts";
import { createDemoAdapter } from "./demo/adapter.ts";
import type { ProviderAdapter } from "./types.ts";

/** Adapters shipped with the server. Real CLIs are added here as their stations land. */
export function builtinAdapters(): ProviderAdapter[] {
  return [createClaudeAdapter(), createCursorAdapter(), createDemoAdapter()];
}
