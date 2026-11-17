import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter } from "./claude/adapter.ts";
import { createCodexAdapter } from "./codex/adapter.ts";
import { createCursorAdapter } from "./cursor/adapter.ts";
import { createDemoAdapter } from "./demo/adapter.ts";
import type { ProviderAdapter } from "./types.ts";

export type BuiltinAdaptersOptions = {
  onClaudeRateLimit?: (info: SDKRateLimitInfo) => void;
};

/** Adapters shipped with the server. Real CLIs are added here as their stations land. */
export function builtinAdapters(options: BuiltinAdaptersOptions = {}): ProviderAdapter[] {
  return [
    createClaudeAdapter({ onRateLimit: options.onClaudeRateLimit }),
    createCodexAdapter(),
    createCursorAdapter(),
    createDemoAdapter(),
  ];
}
