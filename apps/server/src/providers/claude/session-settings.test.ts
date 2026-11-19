import { describe, expect, it } from "vitest";
import { sessionSettings } from "./session-settings.ts";

describe("sessionSettings", () => {
  it("sends nothing when neither is on", () => {
    expect(sessionSettings({})).toEqual({});
    expect(sessionSettings({ fastMode: false, ultracode: false })).toEqual({});
  });

  it("puts what is on in the settings overlay", () => {
    expect(sessionSettings({ fastMode: true })).toEqual({ settings: { fastMode: true } });
    expect(sessionSettings({ fastMode: true, ultracode: true })).toEqual({
      settings: { fastMode: true, ultracode: true },
    });
    expect(sessionSettings({ ultracode: true })).toEqual({ settings: { ultracode: true } });
  });
});
