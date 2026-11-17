import type { ProviderKind, ProviderStatus, RuntimeMode } from "@age/contracts";

export const providerLabels: Record<ProviderKind, string> = {
  claude: "Claude Code",
  cursor: "Cursor Agent",
  codex: "Codex",
  demo: "Demo",
};

export const runtimeModes: { id: RuntimeMode; label: string; short: string }[] = [
  { id: "approve", label: "Ask before edits and commands", short: "Ask first" },
  { id: "auto-edits", label: "Auto-accept edits", short: "Auto edits" },
  { id: "full", label: "Full access", short: "Full access" },
];

export const runtimeLabel = (mode: RuntimeMode) =>
  runtimeModes.find((entry) => entry.id === mode)?.short ?? mode;

export function modelLabel(providers: ProviderStatus[], kind: ProviderKind, model: string) {
  const provider = providers.find((entry) => entry.kind === kind);
  return provider?.models.find((entry) => entry.id === model)?.label ?? model;
}

export const isAvailable = (provider: ProviderStatus) =>
  provider.installed && provider.authenticated !== false && !provider.problem;

export const shortcut = (key: string) => {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? `⌘${key}` : `Ctrl+${key}`;
};
