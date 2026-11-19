import type { AppearanceTheme as Theme } from "@wooky/contracts";
import { readableTextOn } from "./contrast.ts";
import { WALLPAPER_SCENES, assertSafeSvg, toDataUrl } from "./wallpapers/scenes.ts";

let cached: Theme[] | null = null;

function buildWallpaperTheme(scene: (typeof WALLPAPER_SCENES)[number]): Theme {
  assertSafeSvg(scene.svg);
  const text = readableTextOn(scene.canvas);
  return {
    version: 1,
    id: `wall-${scene.id}`,
    name: scene.name,
    appearance: scene.tone,
    canvas: scene.canvas,
    accent: scene.accent,
    colors: { text },
    css: "",
    builtin: true,
    background: {
      image: toDataUrl(scene.svg),
      fit: "cover",
      dim: 0,
      panelBlur: 22,
      surfaceOpacity: 55,
      animated: true,
    },
  };
}

export function getBuiltinWallpaperThemes(): Theme[] {
  cached ??= WALLPAPER_SCENES.map(buildWallpaperTheme);
  return cached;
}
