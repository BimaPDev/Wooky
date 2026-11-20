import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DeviceRecord {
  deviceId: string;
  createdAt: string;
}

/** Stable id for this install; shared with other Anywhere stations via WOOKY_HOME/device.json. */
export function ensureDeviceId(home: string, now: () => string): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "device.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { deviceId?: string };
    if (typeof parsed.deviceId === "string" && parsed.deviceId.length > 0) return parsed.deviceId;
  } catch {
    // missing or corrupt — recreate below only when wx fails on existing file
  }
  const record: DeviceRecord = { deviceId: randomUUID(), createdAt: now() };
  try {
    const flags = openSync(path, "wx");
    writeFileSync(flags, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const retry = JSON.parse(readFileSync(path, "utf8")) as DeviceRecord;
      if (retry.deviceId) return retry.deviceId;
    }
    throw error;
  }
  return record.deviceId;
}
