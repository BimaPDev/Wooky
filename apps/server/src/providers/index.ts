import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { DeviceSettings } from "@age/contracts";
import { createAcpAdapter } from "./acp/adapter.ts";
import { createClaudeAdapter } from "./claude/adapter.ts";
import { createCodexAdapter } from "./codex/adapter.ts";
import { createCursorAdapter } from "./cursor/adapter.ts";
import { createDemoAdapter } from "./demo/adapter.ts";
import type { ProviderSettingsSource } from "./settings.ts";
import { createOpenCodeAdapter } from "./opencode/adapter.ts";
import type { ProviderAdapter } from "./types.ts";

export type BuiltinAdaptersOptions = {
  onClaudeRateLimit?: (info: SDKRateLimitInfo) => void;
  /** Reads the user's per-provider settings when an adapter probes or starts a turn. */
  providerSettings?: ProviderSettingsSource;
  /** Live device settings. OpenCode and ACP read this when a probe or turn starts. */
  deviceSettings?: () => DeviceSettings;
};

/** Adapters shipped with the server. */
export function builtinAdapters(options: BuiltinAdaptersOptions = {}): ProviderAdapter[] {
  const settings = options.deviceSettings;
  return [
    createClaudeAdapter({
      onRateLimit: options.onClaudeRateLimit,
      settings: () => options.providerSettings?.("claude"),
    }),
    createCodexAdapter({ settings: () => options.providerSettings?.("codex") }),
    createCursorAdapter({ settings: () => options.providerSettings?.("cursor") }),
    createDemoAdapter(),
    createOpenCodeAdapter(settings ? { settings } : {}),
    createAcpAdapter(settings ? { settings } : {}),
  ];
}
