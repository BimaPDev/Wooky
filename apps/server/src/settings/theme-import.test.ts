// MIT License — trimmed excerpt from Orbit (t3code-themes) for import tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppearanceTheme } from "@wooky/contracts";
import { importTheme, MAX_THEME_IMPORT_TEXT } from "./theme-import.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const orbitFixture = readFileSync(join(fixtureDir, "orbit-t3code.json"), "utf8");
// Trimmed from Koi Pond by Dwite (t3-themes); the CSS is kept verbatim.
const koiFixture = readFileSync(join(fixtureDir, "koi-pond-t3code.json"), "utf8");

const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#333"/></svg>`;

describe("importTheme", () => {
  it("detects raw SVG", () => {
    const { format, theme } = importTheme(safeSvg, "rain.svg");
    expect(format).toBe("svg");
    expect(theme.id).toBe("rain");
    expect(theme.background?.image?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    AppearanceTheme.parse(theme);
  });

  it("detects t3code JSON and maps roles including variants.light", () => {
    const { format, theme } = importTheme(orbitFixture);
    expect(format).toBe("t3code");
    expect(theme.id).toBe("orbit");
    expect(theme.canvas).toBe("#070b14");
    expect(theme.colors.bg1).toBe("#04070d");
    expect(theme.colors.text2).toBe("#96a3b8");
    expect(theme.variants?.light?.canvas).toBe("#f5f5f2");
    expect(theme.variants?.light?.colors.text).toBe("#11151c");
    expect(theme.css).toBe(".safe { color: var(--text); }");
    AppearanceTheme.parse(theme);
  });

  it("imports Koi Pond with its CSS intact", () => {
    const raw = JSON.parse(koiFixture) as Record<string, unknown>;
    const { format, theme } = importTheme(koiFixture, "koi-pond.json");
    expect(format).toBe("t3code");
    expect(theme.id).toBe("koi-pond");
    expect(theme.css).toBe(raw.css);
    expect(theme.css).toContain('url("data:image/svg+xml,');
    const rawVariants = raw.variants as { light?: { canvas?: string } } | undefined;
    expect(theme.variants?.light?.canvas).toBe(rawVariants?.light?.canvas);
    AppearanceTheme.parse(theme);
  });

  it("reports RTF uploads with a plain-text instruction", () => {
    const rtf = "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2868\\pard hello}";
    expect(() => importTheme(rtf)).toThrow(/rich text \(RTF\), not JSON/);
    expect(() => importTheme(rtf)).toThrow(/Format → Make Plain Text/);
  });

  it("names the failing field when a t3code theme is invalid", () => {
    const raw = JSON.parse(orbitFixture) as Record<string, unknown>;
    const colors = raw.colors as Record<string, unknown>;
    colors.canvas = "not-a-colour";
    expect(() => importTheme(JSON.stringify(raw))).toThrow(
      /Invalid t3 theme field "colors.canvas"/,
    );
    colors.canvas = "#070b14";
    raw.appearance = "blue";
    expect(() => importTheme(JSON.stringify(raw))).toThrow(/Invalid t3 theme field "appearance"/);
  });

  it("rejects unsafe CSS in t3code imports", () => {
    const raw = JSON.parse(orbitFixture) as Record<string, unknown>;
    raw.css = '@import "https://evil.example/a.css"; body { color: red; }';
    expect(() => importTheme(JSON.stringify(raw))).toThrow(/@import/);
  });

  it("rejects import text over the RPC size cap", () => {
    expect(() => importTheme("x".repeat(MAX_THEME_IMPORT_TEXT + 1))).toThrow(/exceeds/);
  });

  it("detects native Wooky JSON", () => {
    const native = {
      version: 1,
      id: "paper",
      name: "Paper",
      appearance: "dark",
      canvas: "#141311",
      accent: "#d7c9a7",
      colors: {},
      css: "",
    };
    const { format, theme } = importTheme(JSON.stringify(native));
    expect(format).toBe("wooky");
    expect(theme.id).toBe("paper");
    expect(theme.builtin).toBeFalsy();
  });
});
