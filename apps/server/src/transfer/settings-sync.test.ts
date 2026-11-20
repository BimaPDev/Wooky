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
});
