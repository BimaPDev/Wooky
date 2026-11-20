import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProviderSettings,
  type AppearanceTheme,
  type DeviceSettings,
  type DeviceSettingsPatch,
  type ProviderKind,
} from "@wooky/contracts";
import type { ThemeStore } from "../settings/themes.ts";

const MAX_HISTORY = 500;
const SYNC_DIR = "sync";
const STAMPS_FILE = "settings-stamps.json";
const HISTORY_FILE = "settings-history.jsonl";

const LOCAL_TOP_LEVEL = new Set([
  "hosting",
  "sync",
  "environments",
  "deviceName",
  "providers",
] as const);

const PROVIDER_LOCAL = new Set(["binaryPath", "env", "extraArgs"] as const);

export type SettingsStamp = { updatedAt: string; deviceId: string };

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
  return LOCAL_TOP_LEVEL.has(key as typeof LOCAL_TOP_LEVEL extends Set<infer T> ? T : never);
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

function mergeProviderPatch(
  current: DeviceSettings["providers"],
  incoming: DeviceSettings["providers"],
): DeviceSettings["providers"] {
  const next = { ...current };
  for (const [kind, patch] of Object.entries(incoming) as [ProviderKind, ProviderSettings][]) {
    if (!patch) continue;
    const prev = next[kind] ?? ProviderSettings.parse({});
    const merged: ProviderSettings = { ...prev, ...patch };
    if (prev.binaryPath !== undefined) merged.binaryPath = prev.binaryPath;
    if (prev.env !== undefined) merged.env = prev.env;
    if (prev.extraArgs !== undefined) merged.extraArgs = prev.extraArgs;
    next[kind] = merged;
  }
  return next;
}

export function exportSettingsForSync(
  home: string,
  _deviceId: string,
  settings: DeviceSettings,
  _now: string,
): { values: Record<string, unknown>; stamps: SettingsStamps } {
  const stamps = readStamps(home);
  return { values: exportSyncableValues(settings), stamps };
}

export function touchLocalSetting(home: string, deviceId: string, key: string, now: string): void {
  if (isLocalKey(key)) return;
  const stamps = readStamps(home);
  stamps[key] = { updatedAt: now, deviceId };
  writeStamps(home, stamps);
}

export function applyRemoteSettings(
  home: string,
  localDeviceId: string,
  themes: ThemeStore,
  remoteValues: Record<string, unknown>,
  remoteStamps: SettingsStamps,
  newId: (prefix: string) => string,
  now: string,
): boolean {
  const stamps = readStamps(home);
  const current = themes.getSettings();
  const patchParts: Record<string, unknown> = {};
  let changed = false;

  for (const [key, value] of Object.entries(remoteValues)) {
    if (isLocalKey(key)) continue;
    const remoteStamp = remoteStamps[key];
    if (!remoteStamp) continue;
    const localStamp = stamps[key];
    if (localStamp && localStamp.updatedAt >= remoteStamp.updatedAt) continue;
    const previous = (current as Record<string, unknown>)[key];
    appendHistory(home, {
      id: newId("settings"),
      key,
      previous,
      at: now,
      deviceId: remoteStamp.deviceId,
    });
    if (key === "providers" && value && typeof value === "object") {
      patchParts.providers = mergeProviderPatch(
        current.providers,
        value as DeviceSettings["providers"],
      );
    } else {
      patchParts[key] = value;
    }
    stamps[key] = remoteStamp;
    changed = true;
  }
  if (!changed) return false;
  writeStamps(home, stamps);
  themes.putSettings(patchParts as DeviceSettingsPatch);
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
