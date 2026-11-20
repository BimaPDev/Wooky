import type { AppearanceTheme as Theme } from "@wooky/contracts";
import { readableTextOn } from "./contrast.ts";
import { buildPixelScenes } from "./wallpapers/pixel-scenes.ts";
import {
  WALLPAPER_SCENES,
  assertSafeSvg,
  toDataUrl,
  type SceneTuning,
} from "./wallpapers/scenes.ts";

let cached: Theme[] | null = null;

const DEFAULT_TUNING: SceneTuning = { dim: 0, panelBlur: 22, surfaceOpacity: 55 };

function background(svg: string, tuning: SceneTuning): NonNullable<Theme["background"]> {
  assertSafeSvg(svg);
  return { image: toDataUrl(svg), fit: "cover", ...tuning, animated: true };
}

function buildWallpaperTheme(scene: (typeof WALLPAPER_SCENES)[number]): Theme {
  const text = readableTextOn(scene.canvas);
  const { variant } = scene;
  return {
    version: 1,
    id: `wall-${scene.id}`,
    name: scene.name,
    appearance: scene.tone,
    canvas: scene.canvas,
    accent: scene.accent,
    colors: { text, ...scene.colors },
    css: scene.css ?? "",
    builtin: true,
    background: background(scene.svg, scene.tuning ?? DEFAULT_TUNING),
    ...(variant
      ? {
          variants: {
            [scene.tone === "dark" ? "light" : "dark"]: {
              canvas: variant.canvas,
              accent: variant.accent,
              colors: variant.colors ?? {},
              background: background(variant.svg, variant.tuning),
            },
          },
        }
      : {}),
  };
}

export function getBuiltinWallpaperThemes(): Theme[] {
  cached ??= [...WALLPAPER_SCENES, ...buildPixelScenes()].map(buildWallpaperTheme);
  return cached;
}
