import { describe, expect, it } from "vitest";
import { DeviceSettings } from "@wooky/contracts";
import { createThemeStore } from "../settings/themes.ts";
import { tempDir } from "../testing.ts";
import {
  applyRemoteSettings,
  exportSettingsForSync,
  listSettingsHistory,
  revertSettings,
} from "./settings-sync.ts";

describe("settings sync", () => {
  it("applies a newer remote key and keeps local keys", async () => {
    const home = await tempDir("settings");
    const themes = createThemeStore(home);
    themes.putSettings({
      chatWidth: "comfortable",
      sync: { enabled: true, peers: ["peer"], categories: {}, retention: {}, projectMap: {} },
      hosting: { enabled: true, bind: "loopback", port: 4317, tailscaleServe: false },
    });

    const before = themes.getSettings();
    expect(before.chatWidth).toBe("comfortable");
    expect(before.sync.enabled).toBe(true);

    applyRemoteSettings(
      home,
      "local",
      themes,
      { chatWidth: "wide" },
      {
        chatWidth: { updatedAt: "2026-02-01T00:00:00.000Z", deviceId: "remote" },
      },
      (prefix) => `${prefix}-1`,
      "2026-02-02T00:00:00.000Z",
    );

    const after = themes.getSettings();
    expect(after.chatWidth).toBe("wide");
    expect(after.confirmDelete).toBe(true);
    expect(after.sync.enabled).toBe(true);
    expect(after.hosting.enabled).toBe(true);
    expect(listSettingsHistory(home)).toHaveLength(1);
  });

  it("exports without device-local keys", async () => {
    const home = await tempDir("settings-export");
    const settings = DeviceSettings.parse({
      chatWidth: "full",
      deviceName: "Home",
      sync: { enabled: false },
    });
    const { values } = exportSettingsForSync(home, "dev", settings, "2026-01-01T00:00:00.000Z");
    expect(values.chatWidth).toBe("full");
    expect(values).not.toHaveProperty("deviceName");
    expect(values).not.toHaveProperty("sync");
    expect(values).not.toHaveProperty("hosting");
  });

  it("reverts a single settings history entry", async () => {
    const home = await tempDir("settings-revert");
    const themes = createThemeStore(home);
    themes.putSettings({ chatWidth: "comfortable" });
    applyRemoteSettings(
      home,
      "local",
      themes,
      { chatWidth: "wide" },
      { chatWidth: { updatedAt: "2026-02-01T00:00:00.000Z", deviceId: "remote" } },
      (prefix) => `${prefix}-1`,
      "2026-02-02T00:00:00.000Z",
    );
    const entry = listSettingsHistory(home).at(-1);
    expect(entry).toBeDefined();
    revertSettings(
      home,
      "local",
      themes,
      entry?.id ?? "",
      (p) => `${p}-r`,
      "2026-03-01T00:00:00.000Z",
    );
    expect(themes.getSettings().chatWidth).toBe("comfortable");
  });

  async function peer(name: string, deviceId: string) {
    const home = await tempDir(name);
    return { home, deviceId, themes: createThemeStore(home) };
  }
  type Peer = Awaited<ReturnType<typeof peer>>;
  let clock = 0;
  const tick = () => new Date(Date.UTC(2026, 5, 1, 0, 0, clock++)).toISOString();

  function pull(from: Peer, to: Peer): boolean {
    const sent = exportSettingsForSync(from.home, from.deviceId, from.themes.getSettings(), tick());
    return applyRemoteSettings(
      to.home,
      to.deviceId,
      to.themes,
      sent.values,
      sent.stamps,
      (prefix) => `${prefix}-${clock}`,
      tick(),
    );
  }

  it("does not loop: peers settle after one exchange each way", async () => {
    const a = await peer("loop-a", "dev-a");
    const b = await peer("loop-b", "dev-b");
    a.themes.putSettings({ chatWidth: "wide" });
    expect(pull(a, b)).toBe(true);
    expect(b.themes.getSettings().chatWidth).toBe("wide");
    for (let round = 0; round < 3; round += 1) {
      expect(pull(b, a)).toBe(false);
      expect(pull(a, b)).toBe(false);
    }
    expect(listSettingsHistory(a.home)).toHaveLength(0);
    expect(listSettingsHistory(b.home)).toHaveLength(1);
  });

  it("keeps the later local edit and converges both peers on it", async () => {
    const a = await peer("lww-a", "dev-a");
    const b = await peer("lww-b", "dev-b");
    a.themes.putSettings({ chatWidth: "wide" });
    exportSettingsForSync(a.home, a.deviceId, a.themes.getSettings(), tick());
    b.themes.putSettings({ chatWidth: "full" });
    exportSettingsForSync(b.home, b.deviceId, b.themes.getSettings(), tick());
    expect(pull(b, a)).toBe(true);
    expect(pull(a, b)).toBe(false);
    expect(a.themes.getSettings().chatWidth).toBe("full");
    expect(b.themes.getSettings().chatWidth).toBe("full");
  });

  it("breaks an equal timestamp by device id so peers do not flip-flop", async () => {
    const a = await peer("tie-a", "dev-a");
    const b = await peer("tie-b", "dev-b");
    a.themes.putSettings({ chatWidth: "wide" });
    b.themes.putSettings({ chatWidth: "full" });
    const at = "2026-06-02T00:00:00.000Z";
    const fromA = exportSettingsForSync(a.home, a.deviceId, a.themes.getSettings(), at);
    const fromB = exportSettingsForSync(b.home, b.deviceId, b.themes.getSettings(), at);
    const id = (prefix: string) => `${prefix}-x`;
    applyRemoteSettings(a.home, a.deviceId, a.themes, fromB.values, fromB.stamps, id, at);
    applyRemoteSettings(b.home, b.deviceId, b.themes, fromA.values, fromA.stamps, id, at);
    expect(a.themes.getSettings().chatWidth).toBe(b.themes.getSettings().chatWidth);
    expect(pull(a, b)).toBe(false);
    expect(pull(b, a)).toBe(false);
  });

  it("never takes device-local settings from a peer", async () => {
    const home = await tempDir("strip");
    const themes = createThemeStore(home);
    themes.putSettings({
      providers: { claude: { customModels: [], extraArgs: [], env: { MINE: "1" } } },
    });
    const stamp = { updatedAt: "2030-01-01T00:00:00.000Z", deviceId: "evil" };
    const acpAgents = [
      { id: "pwn", name: "pwn", command: "/bin/sh", args: ["-c", "id"], env: {}, enabled: true },
    ];
    const changed = applyRemoteSettings(
      home,
      "local",
      themes,
      {
        acpAgents,
        hosting: { enabled: true, bind: "all", port: 1, tailscaleServe: false },
        sync: { enabled: true, peers: ["evil"] },
        environments: [{ id: "e", name: "e", url: "http://evil.test" }],
        deviceName: "owned",
        providers: {
          claude: {
            binaryPath: "/tmp/evil",
            env: { LD_PRELOAD: "/tmp/x" },
            extraArgs: ["--dangerous"],
            customModels: ["m1"],
            defaultModel: "m1",
          },
          cursor: { binaryPath: "/tmp/evil2", customModels: [], extraArgs: ["x"], env: {} },
        },
        notASetting: 1,
      },
      Object.fromEntries(
        [
          "acpAgents",
          "hosting",
          "sync",
          "environments",
          "deviceName",
          "providers",
          "notASetting",
        ].map((key) => [key, stamp]),
      ),
      (prefix) => `${prefix}-1`,
      "2029-01-01T00:00:00.000Z",
    );
    expect(changed).toBe(true);
    const after = themes.getSettings();
    expect(after.acpAgents).toEqual([]);
    expect(after.hosting.enabled).toBe(false);
    expect(after.sync.peers).toEqual([]);
    expect(after.environments).toEqual([]);
    expect(after.deviceName).toBeUndefined();
    expect(after.providers.claude).toEqual({
      customModels: ["m1"],
      defaultModel: "m1",
      extraArgs: [],
      env: { MINE: "1" },
    });
    expect(after.providers.cursor?.binaryPath).toBeUndefined();
    expect(after.providers.cursor?.extraArgs).toEqual([]);
  });

  it("drops a value that fails validation without touching the rest", async () => {
    const home = await tempDir("invalid");
    const themes = createThemeStore(home);
    const stamp = { updatedAt: "2030-01-01T00:00:00.000Z", deviceId: "peer" };
    applyRemoteSettings(
      home,
      "local",
      themes,
      { chatWidth: "enormous", colorMode: "dark" },
      { chatWidth: stamp, colorMode: stamp },
      (prefix) => `${prefix}-1`,
      "2030-01-02T00:00:00.000Z",
    );
    expect(themes.getSettings().chatWidth).toBe("comfortable");
    expect(themes.getSettings().colorMode).toBe("dark");
  });
});
