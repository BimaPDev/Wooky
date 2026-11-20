import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const DeviceFile = z.object({ deviceId: z.string().min(1), createdAt: z.string() });

/** Reads WOOKY_HOME/device.json, creating it (mode 0600) the first time. */
export function loadDeviceId(home: string): string {
  const file = join(home, "device.json");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return DeviceFile.parse(JSON.parse(readFileSync(file, "utf8"))).deviceId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && attempt === 2) throw error;
    }
    mkdirSync(home, { recursive: true });
    const created = { deviceId: randomUUID(), createdAt: new Date().toISOString() };
    try {
      writeFileSync(file, JSON.stringify(created, null, 2), { flag: "wx", mode: 0o600 });
      return created.deviceId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not read or create device.json.");
}
