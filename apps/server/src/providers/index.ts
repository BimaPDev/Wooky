import { createDemoAdapter } from "./demo/adapter.ts";
import type { ProviderAdapter } from "./types.ts";

/** Adapters shipped with the server. Real CLIs are added here as their stations land. */
export function builtinAdapters(): ProviderAdapter[] {
  return [createDemoAdapter()];
}
