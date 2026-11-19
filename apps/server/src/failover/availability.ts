import type {
  DeviceSettings,
  ModelTarget,
  ProviderKind,
  ProviderStatus,
  Thread,
} from "@age/contracts";

export function buildAvailable(
  statuses: readonly ProviderStatus[],
  settings: Pick<DeviceSettings, "disabledProviders">,
  thread: Thread,
): (target: ModelTarget) => boolean {
  const byKind = new Map(statuses.map((status) => [status.kind, status]));
  const disabled = new Set(settings.disabledProviders);
  const planMode = (thread.interactionMode ?? "default") === "plan";

  return (target) => {
    if (disabled.has(target.provider)) return false;
    const status = byKind.get(target.provider);
    if (!status) return false;
    if (!status.installed) return false;
    if (status.authenticated === false) return false;
    if (status.authenticated === null && status.models.length === 0) return false;
    if (planMode && status.capabilities?.planMode !== true) return false;
    if (target.provider === "cursor" && target.model === "auto") return true;
    return status.models.some((model) => model.id === target.model);
  };
}

const ALL_KINDS: readonly ProviderKind[] = ["claude", "cursor", "codex", "demo"];

/** Probes each adapter directly so a timed-out registry list does not mark providers uninstalled. */
export async function probeProvidersFresh(
  get: (kind: ProviderKind) => {
    probe(): Promise<ProviderStatus>;
  } | null,
): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = [];
  for (const kind of ALL_KINDS) {
    const adapter = get(kind);
    if (!adapter) continue;
    try {
      statuses.push(await adapter.probe());
    } catch (error) {
      statuses.push({
        kind,
        label: kind,
        installed: true,
        authenticated: null,
        version: null,
        models: [],
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return statuses;
}
