import { describe, expect, it } from "vitest";
import {
  AppearanceTheme,
  DeviceSettings,
  DeviceSettingsPatch,
  ThemeImage,
  ThemeImportFormat,
} from "./appearance.ts";
import { RpcMethods, ThemesPush } from "./rpc.ts";

const base = {
  id: "paper",
  name: "Paper",
  appearance: "dark" as const,
  canvas: "#141311",
  accent: "#d7c9a7",
};

const svg = "data:image/svg+xml;base64,PHN2Zy8+";

describe("theme images", () => {
  it("accepts an SVG data URL", () => {
    expect(ThemeImage.parse(svg)).toBe(svg);
    const theme = AppearanceTheme.parse({
      ...base,
      background: { image: svg, animated: true, panelBlur: 40 },
    });
    expect(theme.background).toMatchObject({ image: svg, animated: true, panelBlur: 40 });
  });

  it("rejects javascript and html data URLs", () => {
    expect(ThemeImage.safeParse("javascript:alert(1)").success).toBe(false);
    expect(ThemeImage.safeParse("data:text/html;base64,PHN2Zy8+").success).toBe(false);
    expect(
      AppearanceTheme.safeParse({
        ...base,
        background: { image: "javascript:alert(1)" },
      }).success,
    ).toBe(false);
    expect(
      AppearanceTheme.safeParse({
        ...base,
        background: { image: "data:text/html,<svg></svg>" },
      }).success,
    ).toBe(false);
  });

  it("rejects panel blur outside 0-40", () => {
    expect(AppearanceTheme.safeParse({ ...base, background: { panelBlur: 41 } }).success).toBe(
      false,
    );
    expect(AppearanceTheme.safeParse({ ...base, background: { panelBlur: -1 } }).success).toBe(
      false,
    );
  });
});

describe("theme variants", () => {
  it("parses a light variant", () => {
    const theme = AppearanceTheme.parse({
      ...base,
      variants: {
        light: {
          canvas: "#f4f3ef",
          accent: "#8a6a3b",
          colors: { text: "#1c1b18" },
        },
      },
    });
    expect(theme.variants?.light).toMatchObject({
      canvas: "#f4f3ef",
      accent: "#8a6a3b",
      colors: { text: "#1c1b18" },
    });
  });

  it("does not parse a t3code theme as an Wooky theme", () => {
    const t3code = {
      version: 1,
      id: "paper",
      name: "Paper",
      appearance: "dark",
      canvas: "#111111",
      accent: "#cccccc",
      colors: { canvas: "#111111", surface: "#1b1b1b", text: "#f4f3ef" },
      variants: { light: { colors: { canvas: "#f7f7f5", surface: "#ffffff" } } },
      css: "",
    };
    expect(AppearanceTheme.safeParse(t3code).success).toBe(false);
    expect(ThemeImportFormat.parse("t3code")).toBe("t3code");
  });
});

describe("device settings", () => {
  it("defaults wallpaper motion to on", () => {
    expect(DeviceSettings.parse({}).wallpaperMotion).toBe("on");
    expect(DeviceSettings.parse({ activeThemeId: "abyss" }).wallpaperMotion).toBe("on");
    expect(DeviceSettings.safeParse({ wallpaperMotion: "reduced" }).success).toBe(false);
  });

  it("keeps favourite models, at most 30, and a patch with only them leaves the rest alone", () => {
    expect(DeviceSettings.parse({}).favoriteModels).toEqual([]);
    const target = { provider: "claude", model: "default" };
    expect(DeviceSettingsPatch.parse({ favoriteModels: [target] })).toEqual({
      favoriteModels: [target],
    });
    const many = Array.from({ length: 31 }, (_, index) => ({ ...target, model: `m${index}` }));
    expect(DeviceSettingsPatch.safeParse({ favoriteModels: many }).success).toBe(false);
  });

  it("validates the brain extraction model: allowed characters, a length limit, clearable", () => {
    const patch = (extractModel: unknown) =>
      DeviceSettingsPatch.safeParse({ brain: { extractModel } }).success;
    expect(patch({ provider: "claude", model: "haiku" })).toBe(true);
    expect(patch({ provider: "claude", model: "claude-opus-4-1[1m]" })).toBe(true);
    expect(patch({ provider: "claude", model: "anthropic/claude-3.5-sonnet:beta" })).toBe(true);
    expect(patch(null)).toBe(true);
    expect(patch("")).toBe(true);
    expect(patch({ provider: "claude", model: "" })).toBe(false);
    expect(patch({ provider: "claude", model: "x".repeat(101) })).toBe(false);
    expect(patch({ provider: "claude", model: "bad model" })).toBe(false);
    expect(patch({ provider: "claude", model: "--dangerous" })).toBe(false);
    expect(patch({ provider: "claude", model: "a;rm -rf" })).toBe(false);
    expect(patch({ provider: "claude", model: "line\nbreak" })).toBe(false);
    expect(patch("claude")).toBe(false);
    expect(
      DeviceSettings.safeParse({ brain: { extractModel: { provider: "claude", model: "a b" } } })
        .success,
    ).toBe(false);
  });
});

describe("theme rpc", () => {
  it("describes import, activate and the themes push", () => {
    const params = RpcMethods["themes.import"].params.parse({
      text: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      filename: "wall.svg",
      activate: true,
    });
    expect(params).toEqual({
      text: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      filename: "wall.svg",
      activate: true,
    });
    expect(
      RpcMethods["themes.import"].params.safeParse({ text: "x", filename: "a".repeat(256) })
        .success,
    ).toBe(false);
    const imported = RpcMethods["themes.import"].result.parse({
      theme: AppearanceTheme.parse(base),
      format: "svg",
    });
    expect(imported.format).toBe("svg");
    expect(RpcMethods["themes.activate"].params.parse({ id: "paper" })).toEqual({ id: "paper" });
    expect(RpcMethods["themes.activate"].result.parse({}).wallpaperMotion).toBe("on");
    expect(
      ThemesPush.parse({ push: "themes", activeThemeId: "paper", changedIds: ["paper"] }),
    ).toEqual({ push: "themes", activeThemeId: "paper", changedIds: ["paper"] });
  });
});

describe("DeviceSettingsPatch", () => {
  it("keeps only the keys that were sent", () => {
    expect(DeviceSettingsPatch.parse({ chatWidth: "wide" })).toEqual({ chatWidth: "wide" });
  });

  it("rejects an invalid value", () => {
    expect(DeviceSettingsPatch.safeParse({ chatWidth: "huge" }).success).toBe(false);
  });

  it("drops unknown keys", () => {
    expect(DeviceSettingsPatch.parse({ nope: 1, confirmDelete: false })).toEqual({
      confirmDelete: false,
    });
  });

  it("patching sync.enabled leaves hosting and environments untouched", () => {
    const patch = DeviceSettingsPatch.parse({ sync: { enabled: true } });
    expect(patch.hosting).toBeUndefined();
    expect(patch.environments).toBeUndefined();
    expect(patch).toEqual({ sync: { enabled: true } });
  });
});
