import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, platform as osPlatform } from "node:os";
import { join } from "node:path";
import {
  DeviceInfo,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceSettingsPatch,
} from "@wooky/contracts";
import { z } from "zod";
import { writePrivateJson } from "./files.ts";

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

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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

  function loadOrCreate(): z.infer<typeof DeviceFile> {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const created = { deviceId: randomUUID(), createdAt: now() };
      writePrivateJson(path, created);
      return created;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Could not read ${path}.`);
    }
    const parsed = DeviceFile.safeParse(raw);
    if (!parsed.success) throw new Error(`Could not read ${path}.`);
    return parsed.data;
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
