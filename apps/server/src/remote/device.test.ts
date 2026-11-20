import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing.ts";
import { createDevice } from "./device.ts";

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
});
