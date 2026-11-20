import { describe, expect, it } from "vitest";
import { DeviceSettings, DeviceSettingsPatch } from "@wooky/contracts";
import { applySettingsPatch } from "./settings.ts";

const current = DeviceSettings.parse({
  hosting: { port: 5000 },
  sync: {
    peers: ["dev-2"],
    projectMap: { p1: { "dev-2": "/win/app" } },
    categories: { ignoredFiles: true },
    intervalSec: 60,
    retention: { keepDays: 7, keepMin: 10 },
  },
  failover: {
    chain: [{ provider: "claude", model: "opus" }],
    maxSwitchesPerPrompt: 2,
    switchBack: false,
    triggers: ["quota"],
  },
});

describe("applySettingsPatch", () => {
  it("toggles sync.enabled without wiping peers or projectMap", () => {
    const next = applySettingsPatch(
      current,
      DeviceSettingsPatch.parse({ sync: { enabled: true } }),
    );
    expect(next.sync.enabled).toBe(true);
    expect(next.sync.peers).toEqual(["dev-2"]);
    expect(next.sync.projectMap).toEqual({ p1: { "dev-2": "/win/app" } });
    expect(next.sync.intervalSec).toBe(60);
    expect(next.sync.retention).toEqual({ keepDays: 7, keepMin: 10 });
    expect(next.sync.categories.ignoredFiles).toBe(true);
    expect(next.hosting.port).toBe(5000);
  });

  it("toggles one sync category and one hosting flag without the rest", () => {
    const next = applySettingsPatch(
      current,
      DeviceSettingsPatch.parse({
        sync: { categories: { files: false } },
        hosting: { enabled: true },
      }),
    );
    expect(next.sync.categories).toEqual({
      files: false,
      threads: true,
      settings: true,
      themes: true,
      ignoredFiles: true,
    });
    expect(next.hosting).toEqual({ ...current.hosting, enabled: true });
  });

  it("toggles failover.enabled and keeps the chain", () => {
    const next = applySettingsPatch(
      current,
      DeviceSettingsPatch.parse({ failover: { enabled: false } }),
    );
    expect(next.failover.enabled).toBe(false);
    expect(next.failover.chain).toEqual([{ provider: "claude", model: "opus" }]);
    expect(next.failover.maxSwitchesPerPrompt).toBe(2);
    expect(next.failover.switchBack).toBe(false);
    expect(next.failover.triggers).toEqual(["quota"]);
  });

  it("replaces peers and projectMap when those keys are sent", () => {
    const next = applySettingsPatch(
      current,
      DeviceSettingsPatch.parse({ sync: { peers: [], projectMap: {} } }),
    );
    expect(next.sync.peers).toEqual([]);
    expect(next.sync.projectMap).toEqual({});
    expect(next.sync.intervalSec).toBe(60);
  });
});
