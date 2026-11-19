// age-allow-file color: theme summary fixtures use hex canvas/accent like the server sends.
import { describe, expect, it } from "vitest";
import type { AppearanceTheme } from "@wooky/contracts";
import {
  applyPalettePatch,
  applyWallpaperPatch,
  clampThemeName,
  dropHasFiles,
  exportFilename,
  forkAsYours,
  groupThemes,
  importFormatLabel,
  importedStatusText,
  isThemeDropFile,
  looksLikeSvg,
  looksLikeT3code,
  MAX_THEME_FILE_BYTES,
  seedVariant,
  svgLooksAnimated,
  THEME_ID_MAX,
  THEME_NAME_MAX,
  themeBadges,
  themeFileTooLarge,
  themeFromT3code,
  uniqueThemeId,
  wallpaperThemeFromSvg,
  wallpaperWriteTarget,
} from "./helpers.ts";
import { imageCacheKey, THUMBNAIL_LRU_LIMIT, thumbnailLru } from "./thumbnails.ts";

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

describe("uniqueThemeId and clampThemeName", () => {
  it("clamps ids to 64 characters even with a long name", () => {
    const id = uniqueThemeId("a".repeat(80), 1_700_000_000_000);
    expect(id.length).toBeLessThanOrEqual(THEME_ID_MAX);
    expect(id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
  });

  it("clamps names to 80 characters", () => {
    expect(clampThemeName("x".repeat(120)).length).toBe(THEME_NAME_MAX);
    expect(clampThemeName("  Paper  ")).toBe("Paper");
  });

  it("mints distinct ids for duplicate and fork", () => {
    expect(uniqueThemeId("Paper", 1)).not.toBe(uniqueThemeId("Paper", 2));
    const a = forkAsYours(dualTheme(), 10);
    const b = forkAsYours(dualTheme(), 11);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe("wall-ember");
    expect(a.builtin).toBe(false);
    expect(a.name).toBe("Ember copy");
    expect(a.name.length).toBeLessThanOrEqual(THEME_NAME_MAX);
    expect(a.id.length).toBeLessThanOrEqual(THEME_ID_MAX);
  });
});

describe("import wrappers", () => {
  it("wraps an SVG file as a wallpaper theme", () => {
    expect(looksLikeSvg("<svg xmlns='http://www.w3.org/2000/svg'/>")).toBe(true);
    expect(looksLikeSvg("{}", "wall.svg")).toBe(true);
    const theme = wallpaperThemeFromSvg("<svg><rect/></svg>", "ember.svg", 99);
    expect(theme.background?.image?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(theme.background?.animated).toBeUndefined();
    expect(
      wallpaperThemeFromSvg("<svg><animate attributeName='fill'/></svg>", "ember.svg", 99)
        .background?.animated,
    ).toBe(true);
  });

  it("maps a t3code object by colors.canvas", () => {
    const raw = {
      version: 1,
      name: "Paper",
      appearance: "dark",
      colors: { canvas: "#111111", surface: "#1b1b1b" },
    };
    expect(looksLikeT3code(raw)).toBe(true);
    const theme = themeFromT3code(raw, 7);
    expect(theme.canvas).toBe("#111111");
    expect(theme.colors.bg1).toBe("#1b1b1b");
    expect(theme.builtin).toBe(false);
  });
});

describe("applyPalettePatch", () => {
  const theme = dualTheme();

  it("clears a variant background when background is in the patch", () => {
    const next = applyPalettePatch(theme, "light", { background: undefined });
    expect("background" in (next.variants?.light ?? {})).toBe(true);
    expect(next.variants?.light?.background).toBeUndefined();
    expect(next.background?.image).toBeDefined();
  });

  it("keeps the variant background when the patch omits it", () => {
    const next = applyPalettePatch(theme, "light", { canvas: "#eeeeee" });
    expect(next.variants?.light?.background?.image).toBe(theme.variants?.light?.background?.image);
    expect(next.variants?.light?.canvas).toBe("#eeeeee");
  });
});

describe("applyWallpaperPatch", () => {
  it("writes into the variant when the visible wallpaper came from it", () => {
    const theme = dualTheme();
    expect(wallpaperWriteTarget(theme, "light")).toBe("variant");
    const next = applyWallpaperPatch(theme, "light", { dim: 10 });
    expect(next.variants?.light?.background?.dim).toBe(10);
    expect(next.background?.dim).toBe(40);
  });

  it("writes the top-level background when the image is on the base theme", () => {
    const theme = dualTheme();
    expect(wallpaperWriteTarget(theme, "dark")).toBe("base");
    const next = applyWallpaperPatch(theme, "dark", { dim: 8 });
    expect(next.background?.dim).toBe(8);
  });
});

describe("svgLooksAnimated", () => {
  it("detects SMIL and CSS animation hints", () => {
    expect(svgLooksAnimated("<svg><animate attributeName='fill'/></svg>")).toBe(true);
    expect(svgLooksAnimated("<svg><set attributeName='opacity' to='0'/></svg>")).toBe(true);
    expect(svgLooksAnimated("@keyframes drift { from { opacity: 1 } }")).toBe(true);
    expect(svgLooksAnimated("<svg><rect/></svg>")).toBe(false);
  });
});

describe("drop files", () => {
  it("accepts Files in dataTransfer.types", () => {
    expect(dropHasFiles(["Files"])).toBe(true);
    expect(dropHasFiles(["text/plain"])).toBe(false);
  });

  it("ignores typeless files without a theme extension", () => {
    expect(isThemeDropFile({ name: "notes.txt", type: "" } as File)).toBe(false);
    expect(isThemeDropFile({ name: "paper.json", type: "" } as File)).toBe(true);
    expect(isThemeDropFile({ name: "wall.svg", type: "image/svg+xml" } as File)).toBe(true);
  });
});

describe("thumbnail cache keys", () => {
  it("changes when the image string changes", () => {
    const a = imageCacheKey("ember", "data:image/png;base64,aaa");
    const b = imageCacheKey("ember", "data:image/png;base64,bbb");
    expect(a).not.toBe(b);
    expect(a.startsWith("ember:")).toBe(true);
  });

  it("evicts the oldest entry after 24 inserts", () => {
    thumbnailLru.clear();
    for (let i = 0; i < THUMBNAIL_LRU_LIMIT + 1; i += 1) {
      thumbnailLru.set(`k${i}`, `v${i}`);
    }
    expect(thumbnailLru.get("k0")).toBeUndefined();
    expect(thumbnailLru.get("k1")).toBe("v1");
    expect(thumbnailLru.size).toBe(THUMBNAIL_LRU_LIMIT);
    thumbnailLru.clear();
  });
});

function dualTheme(): AppearanceTheme {
  return {
    version: 1,
    id: "wall-ember",
    name: "Ember",
    appearance: "dark",
    canvas: "#1c1814",
    accent: "#e2a54a",
    colors: {},
    css: "",
    builtin: true,
    background: { image: "data:image/png;base64,aaa=", dim: 40 },
    variants: {
      light: {
        canvas: "#f4f3ef",
        accent: "#8a6a3b",
        colors: {},
        background: { image: "data:image/png;base64,bbb=", dim: 20 },
      },
    },
  };
}

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
