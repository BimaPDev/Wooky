import type {
  AppearanceTheme,
  AppearanceThemeSummary,
  ThemeBackground,
  ThemeColorRoles,
  ThemeImportFormat,
  ThemeVariant,
} from "@age/contracts";
import { BASE_PALETTES } from "../../state/theme-data.ts";

export const MAX_THEME_FILE_BYTES = 6 * 1024 * 1024;

export function themeFileTooLarge(byteLength: number): boolean {
  return byteLength > MAX_THEME_FILE_BYTES;
}

export function importFormatLabel(format: ThemeImportFormat): string {
  if (format === "age") return "AGE theme";
  if (format === "t3code") return "t3code theme";
  return "SVG wallpaper";
}

export function importedStatusText(name: string, format: ThemeImportFormat): string {
  return `Imported ${name} (${importFormatLabel(format)})`;
}

export function exportFilename(id: string): string {
  return `${id}.json`;
}

export function themeBadges(theme: AppearanceThemeSummary): string[] {
  const badges: string[] = [];
  if (theme.hasWallpaper) badges.push("Wallpaper");
  if (theme.animated) badges.push("Animated");
  if (theme.modes.length >= 2) badges.push("Light + dark");
  return badges;
}

export type ThemeGroupId = "wallpapers" | "themes" | "yours";

export function groupThemes(themes: AppearanceThemeSummary[]): {
  id: ThemeGroupId;
  label: string;
  themes: AppearanceThemeSummary[];
}[] {
  const wallpapers: AppearanceThemeSummary[] = [];
  const palettes: AppearanceThemeSummary[] = [];
  const yours: AppearanceThemeSummary[] = [];
  for (const theme of themes) {
    if (!theme.builtin) yours.push(theme);
    else if (theme.hasWallpaper) wallpapers.push(theme);
    else palettes.push(theme);
  }
  const groups: { id: ThemeGroupId; label: string; themes: AppearanceThemeSummary[] }[] = [
    { id: "wallpapers", label: "Wallpapers", themes: wallpapers },
    { id: "themes", label: "Themes", themes: palettes },
    { id: "yours", label: "Yours", themes: yours },
  ];
  return groups.filter((group) => group.themes.length > 0);
}

export const THEME_ID_MAX = 64;
export const THEME_NAME_MAX = 80;

export function uniqueThemeId(name: string, now = Date.now()): string {
  const suffix = `-${now.toString(36)}`;
  const budget = Math.max(1, THEME_ID_MAX - suffix.length);
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, budget);
  return `${slug || "theme"}${suffix}`.slice(0, THEME_ID_MAX);
}

export function clampThemeName(name: string): string {
  const trimmed = name.trim() || "Theme";
  return trimmed.slice(0, THEME_NAME_MAX);
}

export function forkAsYours(theme: AppearanceTheme, now = Date.now()): AppearanceTheme {
  const name = clampThemeName(`${theme.name} copy`);
  return {
    ...theme,
    id: uniqueThemeId(name, now),
    name,
    builtin: false,
  };
}

export function seedVariant(mode: "dark" | "light"): ThemeVariant {
  const base = BASE_PALETTES[mode];
  return { canvas: base.bg0, accent: base.accent, colors: {} };
}

export function paletteView(
  theme: AppearanceTheme,
  mode: "dark" | "light",
): {
  canvas: string;
  accent: string;
  colors: AppearanceTheme["colors"];
  background: ThemeBackground | undefined;
} {
  if (mode !== theme.appearance) {
    const variant = theme.variants?.[mode];
    if (variant) {
      return {
        canvas: variant.canvas,
        accent: variant.accent,
        colors: variant.colors,
        background: variant.background,
      };
    }
  }
  return {
    canvas: theme.canvas,
    accent: theme.accent,
    colors: theme.colors,
    background: theme.background,
  };
}

export function previewTheme(theme: AppearanceTheme, mode: "dark" | "light"): AppearanceTheme {
  const view = paletteView(theme, mode);
  return {
    ...theme,
    appearance: mode,
    canvas: view.canvas,
    accent: view.accent,
    colors: view.colors,
    background: view.background,
  };
}

export function wallpaperOf(theme: AppearanceTheme): ThemeBackground {
  return (
    theme.background ?? theme.variants?.dark?.background ?? theme.variants?.light?.background ?? {}
  );
}

export function effectiveColorMode(
  colorMode: "dark" | "light" | "system",
  systemIsLight?: boolean,
): "dark" | "light" {
  if (colorMode === "dark" || colorMode === "light") return colorMode;
  const light =
    systemIsLight ??
    (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches);
  return light ? "light" : "dark";
}

export function wallpaperWriteTarget(
  theme: AppearanceTheme,
  mode: "dark" | "light",
): "base" | "variant" {
  if (mode !== theme.appearance && theme.variants?.[mode]?.background?.image) return "variant";
  return "base";
}

export function applyWallpaperPatch(
  theme: AppearanceTheme,
  mode: "dark" | "light",
  next: Partial<ThemeBackground>,
): AppearanceTheme {
  const target = wallpaperWriteTarget(theme, mode);
  const current =
    target === "variant" ? (theme.variants?.[mode]?.background ?? {}) : (theme.background ?? {});
  const background = omitUndefined({ ...current, ...next });
  if (target === "variant") {
    const existing = theme.variants?.[mode];
    if (!existing) return { ...theme, background };
    return {
      ...theme,
      variants: {
        ...theme.variants,
        [mode]: { ...existing, background },
      },
    };
  }
  return { ...theme, background };
}

export function applyPalettePatch(
  theme: AppearanceTheme,
  editMode: "dark" | "light",
  next: {
    canvas?: string;
    accent?: string;
    colors?: ThemeColorRoles;
    background?: ThemeBackground;
  },
): AppearanceTheme {
  if (editMode === theme.appearance) {
    return { ...theme, ...next };
  }
  const current = paletteView(theme, editMode);
  return {
    ...theme,
    variants: {
      ...theme.variants,
      [editMode]: {
        canvas: next.canvas ?? current.canvas,
        accent: next.accent ?? current.accent,
        colors: next.colors ?? current.colors,
        background: "background" in next ? next.background : current.background,
      },
    },
  };
}

export function omitUndefined<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
      reader.addEventListener("error", () => reject(new Error("Could not read that file.")));
      reader.readAsText(file);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Could not read that file."));
    }
  });
}

export function svgLooksAnimated(markup: string): boolean {
  return /<animate[\s>/]|<set[\s>/]|animateTransform|animateMotion|@keyframes/i.test(markup);
}

export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".json")) return "application/json";
  return "";
}

export function dropHasFiles(types: readonly string[]): boolean {
  return Array.from(types).includes("Files");
}

export function isThemeDropFile(file: File): boolean {
  const type = file.type;
  const name = file.name.toLowerCase();
  const extOk = /\.(json|svg|png|jpe?g|webp)$/.test(name);
  if (!type) return extOk;
  return (
    type === "application/json" ||
    type === "image/svg+xml" ||
    type === "image/png" ||
    type === "image/jpeg" ||
    type === "image/webp" ||
    extOk
  );
}

export function downloadJson(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function looksLikeSvg(text: string, filename?: string): boolean {
  return text.trimStart().startsWith("<svg") || Boolean(filename?.toLowerCase().endsWith(".svg"));
}

export function wallpaperThemeFromSvg(
  svg: string,
  filename?: string,
  now = Date.now(),
): AppearanceTheme {
  const baseName = (filename ?? "Wallpaper").replace(/\.[^.]+$/i, "") || "Wallpaper";
  const name = clampThemeName(baseName);
  const image = svgToDataUrl(svg);
  const dark = BASE_PALETTES.dark;
  return {
    version: 1,
    id: uniqueThemeId(name, now),
    name,
    appearance: "dark",
    canvas: dark.bg0,
    accent: dark.accent,
    colors: {},
    css: "",
    builtin: false,
    background: svgLooksAnimated(svg) ? { image, dim: 40, animated: true } : { image, dim: 40 },
  };
}

export function looksLikeT3code(raw: unknown): raw is {
  name?: unknown;
  appearance?: unknown;
  accent?: unknown;
  css?: unknown;
  colors: { canvas?: unknown; surface?: unknown };
} {
  if (!raw || typeof raw !== "object") return false;
  const colors = (raw as { colors?: unknown }).colors;
  return Boolean(colors && typeof colors === "object" && colors !== null && "canvas" in colors);
}

export function themeFromT3code(raw: unknown, now = Date.now()): AppearanceTheme {
  if (!looksLikeT3code(raw)) throw new Error("That file is not a t3code theme.");
  const name = clampThemeName(typeof raw.name === "string" ? raw.name : "Imported");
  const appearance = raw.appearance === "light" ? "light" : "dark";
  const fallback = BASE_PALETTES[appearance];
  const canvas = hexOr(raw.colors.canvas, fallback.bg0);
  const accent = hexOr(raw.accent, fallback.accent);
  const surface = hexOr(raw.colors.surface, "");
  return {
    version: 1,
    id: uniqueThemeId(name, now),
    name,
    appearance,
    canvas,
    accent,
    colors: surface ? { bg1: surface } : {},
    css: typeof raw.css === "string" ? raw.css : "",
    builtin: false,
  };
}

function hexOr(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
    ? value
    : fallback;
}

export async function wallpaperFileToDataUrl(
  file: File,
): Promise<{ image: string; animated?: boolean }> {
  if (themeFileTooLarge(file.size)) throw new Error("That file is larger than 6 MB.");
  const type = file.type || mimeFromName(file.name);
  const svg = type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  if (svg) {
    const markup = await readFileAsText(file);
    const image = svgToDataUrl(markup);
    if (image.length > 6_000_000) throw new Error("That image is too large.");
    return svgLooksAnimated(markup) ? { image, animated: true } : { image };
  }
  if (!type.startsWith("image/")) throw new Error("That file is not an image.");
  return { image: await rasterToDataUrl(file) };
}

/** Downscale to at most 2560px and re-encode, so a theme stays a small portable file. */
async function rasterToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not create a 2D canvas context.");
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.88, 0.75, 0.6, 0.45]) {
    const url = canvas.toDataURL("image/webp", quality);
    if (url.length < 5_500_000) return url;
  }
  throw new Error("That image is too large even after compression.");
}
