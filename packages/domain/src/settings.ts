import { DeviceSettings, type DeviceSettingsPatch } from "@wooky/contracts";

/** Deep-merges sync, hosting, failover and brain. Arrays and records inside them replace whole. */
export function applySettingsPatch(
  current: DeviceSettings,
  patch: DeviceSettingsPatch,
): DeviceSettings {
  const sync = patch.sync
    ? {
        ...current.sync,
        ...patch.sync,
        ...(patch.sync.categories
          ? { categories: { ...current.sync.categories, ...patch.sync.categories } }
          : {}),
        ...(patch.sync.retention
          ? { retention: { ...current.sync.retention, ...patch.sync.retention } }
          : {}),
      }
    : current.sync;
  const hosting = patch.hosting ? { ...current.hosting, ...patch.hosting } : current.hosting;
  const failover = patch.failover ? { ...current.failover, ...patch.failover } : current.failover;
  const brain = patch.brain ? { ...current.brain, ...patch.brain } : current.brain;
  const { sync: _sync, hosting: _hosting, failover: _failover, brain: _brain, ...rest } = patch;
  return DeviceSettings.parse({ ...current, ...rest, sync, hosting, failover, brain });
}
