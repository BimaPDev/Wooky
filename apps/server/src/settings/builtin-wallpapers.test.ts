import { describe, expect, it } from "vitest";
import { AppearanceTheme } from "@wooky/contracts";
import { getBuiltinWallpaperThemes } from "./builtin-wallpapers.ts";
import { contrastRatio } from "./contrast.ts";

describe("builtin wallpaper themes", () => {
  it("validate against AppearanceTheme with readable text on canvas", () => {
    for (const theme of getBuiltinWallpaperThemes()) {
      const parsed = AppearanceTheme.parse(theme);
      expect(parsed.builtin).toBe(true);
      const text = parsed.colors.text ?? (parsed.appearance === "dark" ? "#f3f0ea" : "#1c1b18");
      expect(contrastRatio(text, parsed.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(parsed.background?.animated).toBe(true);
    }
  });
});
