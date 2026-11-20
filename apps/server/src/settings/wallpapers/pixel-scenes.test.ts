import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppearanceTheme } from "@wooky/contracts";
import { getBuiltinWallpaperThemes } from "../builtin-wallpapers.ts";
import { contrastRatio } from "../contrast.ts";
import { sanitizeThemeCss } from "../css-safety.ts";
import { buildPixelScenes } from "./pixel-scenes.ts";
import { WALLPAPER_SCENES, assertSafeSvg } from "./scenes.ts";

const MAX_BYTES = 64 * 1024;
const MAX_BYTES_FLAGSHIP = 96 * 1024;
const MAX_ANIMATED = 8;

const SCENES = buildPixelScenes();
const PICTURES = SCENES.flatMap((scene) => [
  { key: scene.id, svg: scene.svg },
  ...(scene.variant ? [{ key: `${scene.id}-variant`, svg: scene.variant.svg }] : []),
]);

// Any intended change to a scene changes its hash; update the entry together with the scene.
const HASHES: Record<string, string> = {
  dusk: "0c9c3c92a2ad678c",
  daydream: "3d8176b5ba8b067b",
  reef: "d1743ade149c8507",
  koi: "62357b7f359b534c",
  abyss: "a7af6fccd0c2a379",
  shallows: "2ec42b961c23be22",
  fireflies: "d4ff39712f28c755",
  moonlit: "30cedad1890c258d",
  glyphscape: "c3014c0572c812b3",
  "glyphscape-variant": "aa4d7c05f75530f0",
};

function hash(svg: string): string {
  return createHash("sha256").update(svg).digest("hex").slice(0, 16);
}

function assertBalanced(svg: string): void {
  const stack: string[] = [];
  for (const tag of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = tag;
    if (selfClosing) continue;
    if (!closing) stack.push(name as string);
    else if (stack.pop() !== name) throw new Error(`mismatched </${name}>`);
  }
  expect(stack).toEqual([]);
  expect(svg.replace(/<[^>]*>/g, "")).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos);)/);
}

describe("pixel scenes", () => {
  it("ships the nine scenes with distinct ids and both tones", () => {
    expect(SCENES.map((s) => s.id)).toEqual([
      "dusk",
      "daydream",
      "reef",
      "koi",
      "abyss",
      "shallows",
      "fireflies",
      "moonlit",
      "glyphscape",
    ]);
    const legacy = new Set(WALLPAPER_SCENES.map((s) => s.id));
    for (const scene of SCENES) expect(legacy.has(scene.id)).toBe(false);
    expect(SCENES.find((s) => s.id === "daydream")?.tone).toBe("light");
    expect(SCENES.filter((s) => s.tone === "dark")).toHaveLength(8);
    for (const scene of SCENES) {
      expect(scene.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(scene.canvas).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("parses, passes the sanitizer and stays inside the size budget", () => {
    for (const { key, svg } of PICTURES) {
      expect(() => assertSafeSvg(svg)).not.toThrow();
      assertBalanced(svg);
      expect(
        svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1200"'),
      ).toBe(true);
      expect(svg).toContain("ui-monospace, SFMono-Regular, Menlo, monospace");
      expect(svg).toContain("<text ");
      expect(svg).not.toContain("&#");
      const limit = key.startsWith("glyphscape") ? MAX_BYTES_FLAGSHIP : MAX_BYTES;
      const bytes = Buffer.byteLength(svg, "utf8");
      expect(bytes).toBeGreaterThan(8 * 1024);
      expect(bytes).toBeLessThanOrEqual(limit);
    }
  });

  it("uses a few slow transform/opacity animations only", () => {
    for (const { svg } of PICTURES) {
      const animated = svg.match(/<animate(?:Transform|Motion)?\b[^>]*>/g) ?? [];
      expect(animated.length).toBeGreaterThan(0);
      expect(animated.length).toBeLessThanOrEqual(MAX_ANIMATED);
      for (const el of animated) {
        expect(el).toMatch(/attributeName="(?:transform|opacity)"/);
        expect(el).toContain('repeatCount="indefinite"');
        const dur = /dur="(\d+(?:\.\d+)?)s"/.exec(el);
        expect(Number(dur?.[1])).toBeGreaterThanOrEqual(20);
        expect(Number(dur?.[1])).toBeLessThanOrEqual(120);
      }
      expect(svg).not.toContain("@keyframes");
    }
  });

  it("is deterministic and matches the recorded hashes", () => {
    const again = buildPixelScenes();
    expect(again).toEqual(SCENES);
    expect(Object.fromEntries(PICTURES.map(({ key, svg }) => [key, hash(svg)]))).toEqual(HASHES);
  });

  it("registers every scene as a built-in theme with tuned wallpaper settings", () => {
    const themes = getBuiltinWallpaperThemes();
    for (const scene of SCENES) {
      const theme = themes.find((t) => t.id === `wall-${scene.id}`);
      expect(theme).toBeDefined();
      const parsed = AppearanceTheme.parse(theme);
      expect(parsed.builtin).toBe(true);
      expect(parsed.accent).toBe(scene.accent);
      expect(parsed.background?.panelBlur).toBe(scene.tuning?.panelBlur);
      expect(parsed.background?.surfaceOpacity).toBe(scene.tuning?.surfaceOpacity);
      expect(parsed.background?.dim).toBe(scene.tuning?.dim);
    }
    const day = themes.find((t) => t.id === "wall-daydream");
    expect(day?.appearance).toBe("light");
    expect(day?.background?.surfaceOpacity).toBeGreaterThanOrEqual(75);
  });

  it("gives glyphscape its own palette, a light variant and safe css", () => {
    const theme = getBuiltinWallpaperThemes().find((t) => t.id === "wall-glyphscape");
    const parsed = AppearanceTheme.parse(theme);
    expect(parsed.appearance).toBe("dark");
    expect(parsed.colors.bg0).toBeDefined();
    expect(parsed.colors.accent).toBe(parsed.accent);
    expect(contrastRatio(parsed.colors.text ?? "", parsed.canvas)).toBeGreaterThanOrEqual(7);
    const light = parsed.variants?.light;
    expect(light?.background?.image).toBeDefined();
    expect(light?.background?.image).not.toBe(parsed.background?.image);
    expect(contrastRatio(light?.colors.text ?? "", light?.canvas ?? "")).toBeGreaterThanOrEqual(7);
    expect(parsed.css).not.toBe("");
    expect(sanitizeThemeCss(parsed.css)).toBe(parsed.css);
  });
});
