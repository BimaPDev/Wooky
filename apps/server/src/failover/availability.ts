import type { DeviceSettings, ModelTarget, ProviderStatus } from "@age/contracts";

export function buildAvailable(
  statuses: readonly ProviderStatus[],
  settings: Pick<DeviceSettings, "disabledProviders">,
): (target: ModelTarget) => boolean {
  const byKind = new Map(statuses.map((status) => [status.kind, status]));
  const disabled = new Set(settings.disabledProviders);

  return (target) => {
    if (disabled.has(target.provider)) return false;
    const status = byKind.get(target.provider);
    if (!status) return false;
    if (!status.installed) return false;
    if (status.authenticated !== true) return false;
    if (target.provider === "cursor" && target.model === "auto") return true;
    return status.models.some((model) => model.id === target.model);
  };
}
