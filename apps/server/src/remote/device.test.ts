import { readFileSync, statSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing.ts";
import { createDevice, loadDeviceIdentity } from "./device.ts";

async function open(home: string) {
  return createDevice({
    home,
    getSettings: () => ({}) as never,
    putSettings: () => ({}) as never,
  });
}

describe("device identity", () => {
  it("is created once and stays the same across restarts", async () => {
    const home = await tempDir("device");
    const first = await open(home);
    const second = await open(home);
    expect(second.id()).toBe(first.id());
    expect(JSON.parse(readFileSync(first.path, "utf8")).deviceId).toBe(first.id());
  });

  it("refuses a damaged file instead of minting a new identity over it", async () => {
    const home = await tempDir("device-bad");
    const first = await open(home);
    writeFileSync(first.path, "{ not json");
    await expect(open(home)).rejects.toThrow(/Could not read/);
    expect(readFileSync(first.path, "utf8")).toBe("{ not json");
  });

  it("loadDeviceIdentity writes {deviceId, createdAt} in private mode and accepts an existing file", async () => {
    const home = await tempDir("device-loader");
    const createdAt = "2026-06-01T00:00:00.000Z";
    const first = loadDeviceIdentity(home, () => createdAt);
    expect(first).toEqual({ deviceId: expect.any(String), createdAt });
    const file = join(home, "device.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(first);
    const privateMode = platform() === "win32" || (statSync(file).mode & 0o777) === 0o600;
    expect(privateMode).toBe(true);

    // A second loader, or one that races creation, reads the same file rather than replacing it.
    expect(loadDeviceIdentity(home, () => "2026-07-01T00:00:00.000Z")).toEqual(first);
    writeFileSync(file, JSON.stringify({ deviceId: "existing", createdAt: "earlier" }));
    expect(loadDeviceIdentity(home)).toEqual({ deviceId: "existing", createdAt: "earlier" });
  });
});
