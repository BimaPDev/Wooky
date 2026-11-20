import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeviceIdentity } from "../remote/device.ts";
import { localProject, sharedProjectId } from "./project-map.ts";
import { cleanupSyncTests, tempDir } from "./testing.ts";

afterEach(cleanupSyncTests);

describe("device id", () => {
  it("creates device.json once, mode 0600, and keeps it", async () => {
    const home = await tempDir();
    const id = loadDeviceIdentity(home).deviceId;
    expect(loadDeviceIdentity(home).deviceId).toBe(id);
    const file = JSON.parse(await readFile(join(home, "device.json"), "utf8"));
    expect(file).toEqual({ deviceId: id, createdAt: expect.any(String) });
    const mode = (await stat(join(home, "device.json"))).mode & 0o777;
    expect(process.platform === "win32" || mode === 0o600).toBe(true);
  });

  it("reads the file the pairing station wrote", async () => {
    const home = await tempDir();
    await writeFile(
      join(home, "device.json"),
      JSON.stringify({ deviceId: "from-a1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(loadDeviceIdentity(home).deviceId).toBe("from-a1");
  });
});

describe("project mapping", () => {
  const map = { shared: { me: "/work/app", peer: "/home/app" } };
  const projects = [
    { id: "p-local", root: "/work/app" },
    { id: "p-other", root: "/work/other" },
  ];

  it("uses the projectMap key whose entry points at the folder, else the own id", () => {
    expect(sharedProjectId(projects[0] as never, "me", map)).toBe("shared");
    expect(sharedProjectId(projects[1] as never, "me", map)).toBe("p-other");
  });

  it("finds the local project behind a shared id, or null when unmapped", () => {
    expect(localProject("shared", projects, "me", map)?.id).toBe("p-local");
    expect(localProject("p-other", projects, "me", map)?.id).toBe("p-other");
    expect(localProject("unknown", projects, "me", map)).toBeNull();
  });
});
