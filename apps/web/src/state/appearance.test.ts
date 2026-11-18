// age-allow-file color: assertions on generated theme CSS compare hex values.
import { AppearanceTheme } from "@age/contracts";
import { describe, expect, it } from "vitest";
import { accentInkFor, buildAppearanceCss, contrastRatio } from "./appearance.ts";
import { BASE_PALETTES } from "./theme-data.ts";

const ui = { appearanceContrast: 100, glassOpacity: 80 };
const line = (css: string) => /--line: (#[0-9a-f]{6});/.exec(css)?.[1];
const theme = AppearanceTheme.parse({
  id: "neon",
  name: "Neon",
  appearance: "dark",
  canvas: "#101020",
  accent: "#ff00aa",
  colors: { text2: "#abcdef" },
  fonts: { ui: '"Geist", Inter', size: 15 },
  shape: { radius: 12, density: "compact" },
});

describe("buildAppearanceCss", () => {
  it("outranks tokens.css in forced and system modes", () => {
    const css = buildAppearanceCss(theme, ui);
    expect(css).toContain('html:root[data-theme="dark"] {');
    expect(css).toContain("html:root:not([data-theme])");
    expect(css).toContain("--bg-0: #101020;");
    expect(css).toContain("--accent: #ff00aa;");
    expect(css).toContain("--text-2: #abcdef;");
  });

  it("keeps the default light palette when the theme is dark", () => {
    const css = buildAppearanceCss(theme, ui);
    const light = css.slice(css.indexOf('html:root[data-theme="light"]'));
    expect(light).toContain("--bg-0: #f4f3ef;");
  });

  it("emits typography, radius and density", () => {
    const css = buildAppearanceCss(theme, ui);
    expect(css).toContain('--font-ui: "Geist", Inter, system-ui, sans-serif;');
    expect(css).toContain("--text-base: 15px;");
    expect(css).toContain("--radius: 12px;");
    expect(css).toContain("--space-4: 13px;");
  });

  it("applies contrast to hairlines but leaves the canvas alone", () => {
    const flat = buildAppearanceCss(null, ui);
    const sharp = buildAppearanceCss(null, { ...ui, appearanceContrast: 150 });
    expect(line(sharp)).not.toBe(line(flat));
    expect(sharp).toContain("--bg-0: #0a0a0a;");
  });

  it("layers a background image under translucent surfaces", () => {
    const withImage = AppearanceTheme.parse({
      ...theme,
      background: { image: "data:image/png;base64,iVBORw0KGgo=", dim: 50 },
    });
    const css = buildAppearanceCss(withImage, ui);
    expect(css).toContain('url("data:image/png;base64,iVBORw0KGgo=")');
    expect(css).toMatch(/--bg-0: #101020[0-9a-f]{2};/);
  });
});

describe("default dark palette contrast", () => {
  const dark = BASE_PALETTES.dark;

  it("meets WCAG AA for body text on layered surfaces", () => {
    expect(contrastRatio(dark.text, dark.bg0)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.text2, dark.bg1)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.text, dark.bg2)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("accent ink", () => {
  it("picks the ink with the higher contrast, including mid-tone accents", () => {
    for (const accent of ["#e0533d", "#3b82f6", "#22c55e", "#ffd60a", "#7c3aed", "#808080"]) {
      const ink = accentInkFor(accent);
      const other =
        ink === BASE_PALETTES.dark.accentInk
          ? BASE_PALETTES.light.accentInk
          : BASE_PALETTES.dark.accentInk;
      expect(contrastRatio(ink, accent)).toBeGreaterThanOrEqual(contrastRatio(other, accent));
      expect(contrastRatio(ink, accent)).toBeGreaterThan(3);
    }
  });
});

describe("theme contract", () => {
  it("rejects font lists that could break out of the declaration", () => {
    const bad = { ...theme, fonts: { ui: "x; } body { display: none" } };
    expect(AppearanceTheme.safeParse(bad).success).toBe(false);
  });

  it("rejects non-data background URLs", () => {
    const bad = { ...theme, background: { image: "https://example.com/a.png" } };
    expect(AppearanceTheme.safeParse(bad).success).toBe(false);
  });
});
