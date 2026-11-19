// age-allow-file color: theme summary fixtures use hex canvas/accent like the server sends.
import { describe, expect, it } from "vitest";
import {
  exportFilename,
  groupThemes,
  importFormatLabel,
  importedStatusText,
  MAX_THEME_FILE_BYTES,
  seedVariant,
  themeBadges,
  themeFileTooLarge,
} from "./helpers.ts";

describe("themeFileTooLarge", () => {
  it("allows files up to 6 MB", () => {
    expect(themeFileTooLarge(MAX_THEME_FILE_BYTES)).toBe(false);
    expect(themeFileTooLarge(MAX_THEME_FILE_BYTES - 1)).toBe(false);
  });

  it("rejects files larger than 6 MB", () => {
    expect(themeFileTooLarge(MAX_THEME_FILE_BYTES + 1)).toBe(true);
  });
});

describe("import format labels", () => {
  it("names each detected format in sentence case", () => {
    expect(importFormatLabel("age")).toBe("AGE theme");
    expect(importFormatLabel("t3code")).toBe("t3code theme");
    expect(importFormatLabel("svg")).toBe("SVG wallpaper");
  });

  it("builds the inline import status line", () => {
    expect(importedStatusText("Orbit", "t3code")).toBe("Imported Orbit (t3code theme)");
    expect(importedStatusText("Paper", "age")).toBe("Imported Paper (AGE theme)");
    expect(importedStatusText("Ember", "svg")).toBe("Imported Ember (SVG wallpaper)");
  });
});

describe("exportFilename", () => {
  it("downloads the theme as <id>.json", () => {
    expect(exportFilename("paper")).toBe("paper.json");
    expect(exportFilename("wall-ember")).toBe("wall-ember.json");
  });
});

describe("themeBadges", () => {
  it("lists wallpaper, animated and dual-mode badges", () => {
    expect(
      themeBadges({
        id: "wall-ember",
        name: "Ember",
        appearance: "dark",
        canvas: "#1c1814",
        accent: "#e2a54a",
        builtin: true,
        hasCss: false,
        hasWallpaper: true,
        animated: true,
        modes: ["dark", "light"],
      }),
    ).toEqual(["Wallpaper", "Animated", "Light + dark"]);
  });

  it("omits badges the theme does not earn", () => {
    expect(
      themeBadges({
        id: "default",
        name: "Default",
        appearance: "dark",
        canvas: "#0d0d0c",
        accent: "#d7c9a7",
        builtin: true,
        hasCss: false,
        hasWallpaper: false,
        animated: false,
        modes: ["dark"],
      }),
    ).toEqual([]);
  });
});

describe("groupThemes", () => {
  it("splits builtin wallpapers, palettes and user themes", () => {
    const grouped = groupThemes([
      summary({ id: "default", name: "Default" }),
      summary({ id: "wall-ember", name: "Ember", hasWallpaper: true, animated: true }),
      summary({ id: "mine", name: "Mine", builtin: false, hasWallpaper: true }),
    ]);
    expect(grouped.map((group) => [group.label, group.themes.map((theme) => theme.id)])).toEqual([
      ["Wallpapers", ["wall-ember"]],
      ["Themes", ["default"]],
      ["Yours", ["mine"]],
    ]);
  });
});

describe("seedVariant", () => {
  it("seeds canvas and accent from the base palette for that mode", () => {
    const light = seedVariant("light");
    expect(light.canvas).toMatch(/^#/);
    expect(light.accent).toMatch(/^#/);
    expect(light.colors).toEqual({});
    expect(seedVariant("dark").canvas).not.toBe(light.canvas);
  });
});

function summary(overrides: {
  id: string;
  name: string;
  builtin?: boolean;
  hasWallpaper?: boolean;
  animated?: boolean;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    appearance: "dark" as const,
    canvas: "#0d0d0c",
    accent: "#d7c9a7",
    builtin: overrides.builtin ?? true,
    hasCss: false,
    hasWallpaper: overrides.hasWallpaper ?? false,
    animated: overrides.animated ?? false,
    modes: ["dark" as const],
  };
}
