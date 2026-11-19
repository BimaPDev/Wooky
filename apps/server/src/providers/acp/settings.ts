import {
  DeviceSettings,
  ProviderSettings,
  type DeviceSettings as DeviceSettingsValue,
  type ProviderSettings as ProviderSettingsValue,
} from "@wooky/contracts";

export function loadSettings(read?: () => DeviceSettingsValue): DeviceSettingsValue {
  if (!read) return DeviceSettings.parse({});
  try {
    const parsed = DeviceSettings.safeParse(read());
    return parsed.success ? parsed.data : DeviceSettings.parse({});
  } catch {
    return DeviceSettings.parse({});
  }
}

export function settingsFor(
  settings: DeviceSettingsValue,
  kind: "acp" | "opencode",
): ProviderSettingsValue {
  return ProviderSettings.parse(settings.providers[kind] ?? {});
}
