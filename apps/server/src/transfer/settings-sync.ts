import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DeviceSettings,
  ProviderKind,
  ProviderSettings,
  type AppearanceTheme,
  type DeviceSettingsPatch,
} from "@wooky/contracts";
import type { ThemeStore } from "../settings/themes.ts";

const MAX_HISTORY = 500;
const SYNC_DIR = "sync";
const STAMPS_FILE = "settings-stamps.json";
const HISTORY_FILE = "settings-history.jsonl";

/** Only these top-level keys leave or enter this device. Everything else is device-local. */
const SYNCED_KEYS: ReadonlySet<string> = new Set([
  "activeThemeId",
  "colorMode",
  "appearanceContrast",
  "glassOpacity",
  "chatWidth",
  "threadNotifications",
  "inAppNotifications",
  "projectGrouping",
  "confirmDelete",
  "confirmArchive",
  "disabledProviders",
  "providers",
  "followUp",
  "importLocalHistory",
  "wallpaperMotion",
  "failover",
  "favoriteModels",
]);

const PROVIDER_LOCAL = new Set(["binaryPath", "env", "extraArgs"] as const);

export type SettingsStamp = { updatedAt: string; deviceId: string; hash?: string };

export type SettingsStamps = Record<string, SettingsStamp>;

export interface SettingsHistoryEntry {
  id: string;
  key: string;
  previous: unknown;
  at: string;
  deviceId: string;
}

function syncDir(home: string): string {
  const dir = join(home, SYNC_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readStamps(home: string): SettingsStamps {
  const path = join(syncDir(home), STAMPS_FILE);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SettingsStamps;
  } catch {
    return {};
  }
}

function writeStamps(home: string, stamps: SettingsStamps): void {
  writeFileSync(join(syncDir(home), STAMPS_FILE), `${JSON.stringify(stamps, null, 2)}\n`, {
    mode: 0o600,
  });
}

function appendHistory(home: string, entry: SettingsHistoryEntry): void {
  const path = join(syncDir(home), HISTORY_FILE);
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {}
  lines.push(JSON.stringify(entry));
  if (lines.length > MAX_HISTORY) lines = lines.slice(lines.length - MAX_HISTORY);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function isLocalKey(key: string): boolean {
  return !SYNCED_KEYS.has(key);
}

function exportSyncableValues(settings: DeviceSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isLocalKey(key)) continue;
    if (key === "providers") {
      const providers: Record<string, unknown> = {};
      for (const [kind, config] of Object.entries(settings.providers)) {
        if (!config) continue;
        const copy = { ...config };
        for (const local of PROVIDER_LOCAL) delete (copy as Record<string, unknown>)[local];
        providers[kind] = copy;
      }
      out.providers = providers;
      continue;
    }
    out[key] = value;
  }
  return out;
}

const SharedProviderFields = ProviderSettings.pick({
  customModels: true,
  defaultModel: true,
}).partial();

/** Takes the shareable provider fields from the peer and keeps every device-local one. */
function mergeProviderPatch(
  current: DeviceSettings["providers"],
  incoming: unknown,
): DeviceSettings["providers"] | null {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return null;
  const next = { ...current };
  for (const [kind, raw] of Object.entries(incoming)) {
    if (!ProviderKind.safeParse(kind).success) continue;
    const shared = SharedProviderFields.safeParse(raw);
    if (!shared.success) continue;
    const patch = shared.data;
    const prev = next[kind as ProviderKind] ?? ProviderSettings.parse({});
    const merged: ProviderSettings = {
      customModels: patch.customModels ?? prev.customModels,
      extraArgs: prev.extraArgs,
      env: prev.env,
    };
    if (prev.binaryPath !== undefined) merged.binaryPath = prev.binaryPath;
    if (patch.defaultModel !== undefined) merged.defaultModel = patch.defaultModel;
    next[kind as ProviderKind] = merged;
  }
  return next;
}

function valueHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

/**
 * Stamps keys edited on this device since the last look, so a local edit wins over an older
 * remote value. A key with no stamp and a default value was never edited.
 */
function refreshStamps(home: string, deviceId: string, settings: DeviceSettings, now: string) {
  const stamps = readStamps(home);
  const shared = exportSyncableValues(settings);
  const defaults = exportSyncableValues(DeviceSettings.parse({}));
  let changed = false;
  for (const [key, value] of Object.entries(shared)) {
    const hash = valueHash(value);
    const stamp = stamps[key];
    if (stamp?.hash === hash) continue;
    if (!stamp && hash === valueHash(defaults[key])) continue;
    if (stamp && stamp.hash === undefined) {
      stamps[key] = { ...stamp, hash };
      changed = true;
      continue;
    }
    stamps[key] = { updatedAt: now, deviceId, hash };
    changed = true;
  }
  if (changed) writeStamps(home, stamps);
}

/** Remote wins on a later time. An equal time goes to the larger device id so peers converge. */
function isNewer(remote: SettingsStamp, local: SettingsStamp | undefined): boolean {
  if (!local) return true;
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt;
  return remote.deviceId > local.deviceId;
}

export function exportSettingsForSync(
  home: string,
  deviceId: string,
  settings: DeviceSettings,
  now: string,
): { values: Record<string, unknown>; stamps: SettingsStamps } {
  refreshStamps(home, deviceId, settings, now);
  const stamps: SettingsStamps = {};
  for (const [key, stamp] of Object.entries(readStamps(home))) {
    if (!isLocalKey(key)) stamps[key] = { updatedAt: stamp.updatedAt, deviceId: stamp.deviceId };
  }
  return { values: exportSyncableValues(settings), stamps };
}

export function touchLocalSetting(home: string, deviceId: string, key: string, now: string): void {
  if (isLocalKey(key)) return;
  const stamps = readStamps(home);
  stamps[key] = { updatedAt: now, deviceId };
  writeStamps(home, stamps);
}

const SyncStampShape = z.object({
  updatedAt: z.string().min(1).max(40),
  deviceId: z.string().min(1),
});

/**
 * Applies what a peer sent. Device-local keys, unknown keys, keys without a stamp and
 * values that fail validation are dropped. The peer's stamp is kept as is, so the same
 * value never looks newer when it is exported back.
 */
export function applyRemoteSettings(
  home: string,
  localDeviceId: string,
  themes: ThemeStore,
  remoteValues: Record<string, unknown>,
  remoteStamps: SettingsStamps,
  newId: (prefix: string) => string,
  now: string,
): boolean {
  refreshStamps(home, localDeviceId, themes.getSettings(), now);
  const stamps = readStamps(home);
  const current = themes.getSettings();
  const patchParts: Record<string, unknown> = {};
  const applied: Array<{ key: string; stamp: SettingsStamp }> = [];

  for (const [key, value] of Object.entries(remoteValues)) {
    if (isLocalKey(key)) continue;
    const remoteStamp = SyncStampShape.safeParse(remoteStamps[key]);
    if (!remoteStamp.success) continue;
    if (!isNewer(remoteStamp.data, stamps[key])) continue;
    let accepted: unknown;
    if (key === "providers") {
      const merged = mergeProviderPatch(current.providers, value);
      if (!merged) continue;
      accepted = merged;
    } else {
      const shape = (DeviceSettings.shape as Record<string, z.ZodType>)[key];
      const parsed = shape?.safeParse(value);
      if (!parsed?.success) continue;
      accepted = parsed.data;
    }
    if (valueHash(accepted) === valueHash((current as Record<string, unknown>)[key])) {
      stamps[key] = { ...remoteStamp.data, hash: valueHash(exportSyncableValues(current)[key]) };
      continue;
    }
    appendHistory(home, {
      id: newId("settings"),
      key,
      previous: (current as Record<string, unknown>)[key],
      at: now,
      deviceId: remoteStamp.data.deviceId,
    });
    patchParts[key] = accepted;
    applied.push({ key, stamp: remoteStamp.data });
  }
  if (applied.length === 0) {
    writeStamps(home, stamps);
    return false;
  }
  let saved: DeviceSettings;
  try {
    saved = themes.putSettings(patchParts as DeviceSettingsPatch);
  } catch {
    writeStamps(home, stamps);
    return false;
  }
  const projection = exportSyncableValues(saved);
  for (const { key, stamp } of applied) {
    stamps[key] = { ...stamp, hash: valueHash(projection[key]) };
  }
  writeStamps(home, stamps);
  return true;
}

export function listSettingsHistory(home: string): SettingsHistoryEntry[] {
  const path = join(syncDir(home), HISTORY_FILE);
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as SettingsHistoryEntry);
  } catch {
    return [];
  }
}

export function revertSettings(
  home: string,
  deviceId: string,
  themes: ThemeStore,
  entryId: string,
  newId: (prefix: string) => string,
  now: string,
): DeviceSettings {
  const entries = listSettingsHistory(home);
  const entry = entries.find((item) => item.id === entryId);
  if (!entry) throw new Error(`No settings history entry ${entryId}`);
  const key = entry.key;
  if (isLocalKey(key)) throw new Error(`${key} is device-local and cannot be reverted`);
  const patch: DeviceSettingsPatch = { [key]: entry.previous } as DeviceSettingsPatch;
  const current = themes.getSettings();
  appendHistory(home, {
    id: newId("settings"),
    key,
    previous: (current as Record<string, unknown>)[key],
    at: now,
    deviceId,
  });
  touchLocalSetting(home, deviceId, key, now);
  return themes.putSettings(patch);
}

export function themeExportPayload(
  themes: ThemeStore,
): Array<{ theme: AppearanceTheme; hash: string }> {
  const { themes: list } = themes.list();
  const out: Array<{ theme: AppearanceTheme; hash: string }> = [];
  for (const summary of list) {
    if (summary.builtin) continue;
    const theme = themes.get(summary.id);
    const image = theme.background?.image;
    if (image && Buffer.byteLength(image, "utf8") > 5 * 1024 * 1024) continue;
    const hash = createHash("sha256").update(JSON.stringify(theme)).digest("hex");
    out.push({ theme, hash });
  }
  return out;
}
