import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname, platform as osPlatform } from "node:os";
import { join } from "node:path";
import {
  DeviceInfo,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceSettingsPatch,
} from "@wooky/contracts";
import { z } from "zod";

const DeviceFile = z.object({
  deviceId: z.string().min(1),
  createdAt: z.string().min(1),
});

function thisPlatform(): DevicePlatform {
  const value = osPlatform();
  if (value === "darwin" || value === "win32" || value === "linux") return value;
  return "other";
}

function serverVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = parsed.version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // The package file is missing in a bundled layout.
  }
  return "0.0.0";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function createDevice(options: {
  home: string;
  getSettings: () => DeviceSettings;
  putSettings: (patch: DeviceSettingsPatch) => DeviceSettings;
  now?: () => string;
}) {
  const path = join(options.home, "device.json");
  const now = options.now ?? (() => new Date().toISOString());
  const version = serverVersion();
  const record = loadOrCreate();

  function readExisting(): z.infer<typeof DeviceFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw error;
      throw new Error(`Could not read ${path}.`, { cause: error });
    }
    const parsed = DeviceFile.safeParse(raw);
    if (!parsed.success) throw new Error(`Could not read ${path}.`);
    return parsed.data;
  }

  function loadOrCreate(): z.infer<typeof DeviceFile> {
    try {
      return readExisting();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const created = { deviceId: randomUUID(), createdAt: now() };
    try {
      writeFileSync(path, JSON.stringify(created, null, 2), { flag: "wx", mode: 0o600 });
      return created;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    return readExisting();
  }

  function displayName(): string {
    const configured = options.getSettings().deviceName?.trim();
    if (configured) return configured;
    const host = hostname().trim();
    return host.length > 0 ? host : "wooky";
  }

  function info(): DeviceInfo {
    return DeviceInfo.parse({
      deviceId: record.deviceId,
      name: displayName(),
      platform: thisPlatform(),
      version,
    });
  }

  function rename(name: string): DeviceInfo {
    options.putSettings({ deviceName: name });
    return info();
  }

  return { info, rename, id: () => record.deviceId, path };
}
