import {
  AppearanceTheme,
  HexColor,
  type AppearanceTheme as Theme,
  type ThemeColorRoles,
  type ThemeImportFormat,
  type ThemeVariant,
} from "@wooky/contracts";
import { assertSafeSvg, toDataUrl } from "./wallpapers/scenes.ts";
import { validateThemeContent } from "./theme-validate.ts";

export const MAX_THEME_IMPORT_TEXT = 7_000_000;

const SVG_START_RE = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i;
const ANIMATED_SVG_RE = /<\s*animate(?:Transform)?\b|@keyframes\b|<\s*set\b/i;

const T3_TO_AGE: Record<string, keyof ThemeColorRoles | "canvas" | "accent"> = {
  canvas: "canvas",
  sidebar: "bg1",
  surface: "bg2",
  surfaceRaised: "bg3",
  sidebarRowHover: "bgHover",
  sidebarRowActive: "bgActive",
  border: "line",
  input: "lineStrong",
  text: "text",
  textMuted: "text2",
  placeholder: "text3",
  iconMuted: "text4",
  accent: "accent",
  accentForeground: "accentInk",
  focus: "focus",
  warning: "amber",
  warningSurface: "amberBg",
  error: "red",
  errorSurface: "redBg",
};

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug.length > 0 && /^[a-z0-9]/.test(slug) ? slug : "wallpaper";
}

function idFromFilename(filename: string | undefined, fallback: string): string {
  if (!filename) return slugify(fallback);
  const base = filename.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  return slugify(base || fallback);
}

function mapT3Colors(colors: Record<string, unknown>): {
  canvas: string;
  accent: string;
  roles: ThemeColorRoles;
} {
  let canvas = "#0c0c0c";
  let accent = "#d7c9a7";
  const roles: ThemeColorRoles = {};
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value !== "string") continue;
    const parsed = HexColor.safeParse(value);
    if (!parsed.success) continue;
    const target = T3_TO_AGE[key];
    if (target === "canvas") canvas = parsed.data;
    else if (target === "accent") accent = parsed.data;
    else if (target) roles[target] = parsed.data;
  }
  return { canvas, accent, roles };
}

function mapT3Variant(raw: Record<string, unknown>): ThemeVariant | undefined {
  const nested =
    typeof raw.colors === "object" && raw.colors !== null
      ? (raw.colors as Record<string, unknown>)
      : {};
  const merged = { ...nested, ...raw };
  delete merged.colors;
  const mapped = mapT3Colors(merged);
  return {
    canvas: mapped.canvas,
    accent: mapped.accent,
    colors: mapped.roles,
  };
}

function isT3codeTheme(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string") return false;
  if (obj.appearance !== "dark" && obj.appearance !== "light") return false;
  const colors = obj.colors;
  if (typeof colors !== "object" || colors === null) return false;
  return typeof (colors as Record<string, unknown>).canvas === "string";
}

function isWookyTheme(value: unknown): boolean {
  return AppearanceTheme.safeParse(value).success;
}

function importSvg(text: string, filename?: string): { theme: Theme; format: ThemeImportFormat } {
  assertSafeSvg(text);
  const appearance =
    filename !== undefined && filename.toLowerCase().includes("light") ? "light" : "dark";
  const canvas = appearance === "light" ? "#fafaf8" : "#0c0c0c";
  const accent = "#d7c9a7";
  const id = idFromFilename(filename, "wallpaper");
  const theme = AppearanceTheme.parse({
    version: 1,
    id,
    name: id
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    appearance,
    canvas,
    accent,
    colors: {},
    css: "",
    builtin: false,
    background: {
      image: toDataUrl(text),
      fit: "cover",
      dim: 0,
      panelBlur: 22,
      surfaceOpacity: 55,
      animated: ANIMATED_SVG_RE.test(text),
    },
  });
  return { theme, format: "svg" };
}

function importT3code(raw: Record<string, unknown>): { theme: Theme; format: ThemeImportFormat } {
  const name = String(raw.name);
  const id = slugify(name);
  const { canvas, accent, roles } = mapT3Colors((raw.colors ?? {}) as Record<string, unknown>);
  const appearance = raw.appearance === "light" ? "light" : "dark";
  const css = typeof raw.css === "string" ? raw.css.trim() : "";
  const variants: Theme["variants"] = {};
  const rawVariants = raw.variants;
  if (typeof rawVariants === "object" && rawVariants !== null) {
    const v = rawVariants as Record<string, unknown>;
    if (typeof v.light === "object" && v.light !== null) {
      const mapped = mapT3Variant(v.light as Record<string, unknown>);
      if (mapped) variants.light = mapped;
    }
    if (typeof v.dark === "object" && v.dark !== null) {
      const mapped = mapT3Variant(v.dark as Record<string, unknown>);
      if (mapped) variants.dark = mapped;
    }
  }
  const theme = AppearanceTheme.parse({
    version: 1,
    id,
    name,
    appearance,
    canvas,
    accent,
    colors: roles,
    variants: Object.keys(variants).length > 0 ? variants : undefined,
    css,
    builtin: false,
  });
  return { theme, format: "t3code" };
}

function importWooky(raw: unknown): { theme: Theme; format: ThemeImportFormat } {
  const theme = AppearanceTheme.parse({ ...(raw as object), builtin: false });
  return { theme, format: "wooky" };
}

export function importTheme(
  text: string,
  filename?: string,
): { theme: Theme; format: ThemeImportFormat } {
  if (text.length > MAX_THEME_IMPORT_TEXT) {
    throw new Error(`Theme import text exceeds ${MAX_THEME_IMPORT_TEXT} characters.`);
  }
  let result: { theme: Theme; format: ThemeImportFormat };
  if (SVG_START_RE.test(text)) {
    result = importSvg(text, filename);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Unrecognized theme format.");
    }

    if (isWookyTheme(parsed)) result = importWooky(parsed);
    else if (isT3codeTheme(parsed)) result = importT3code(parsed);
    else throw new Error("Unrecognized theme format.");
  }

  validateThemeContent(result.theme);
  return result;
}
