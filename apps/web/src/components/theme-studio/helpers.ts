import type {
  AppearanceTheme,
  AppearanceThemeSummary,
  ThemeBackground,
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

export function uniqueThemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "theme"}-${Date.now().toString(36)}`;
}

export function forkAsYours(theme: AppearanceTheme): AppearanceTheme {
  return {
    ...theme,
    id: uniqueThemeId(theme.name),
    name: `${theme.name} copy`,
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

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(new Error("Could not read that file.")));
    reader.readAsText(file);
  });
}

export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export async function wallpaperFileToDataUrl(
  file: File,
): Promise<{ image: string; animated?: boolean }> {
  if (themeFileTooLarge(file.size)) throw new Error("That file is larger than 6 MB.");
  const svg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
  if (svg) {
    const image = svgToDataUrl(await readFileAsText(file));
    if (image.length > 6_000_000) throw new Error("That image is too large.");
    return { image, animated: true };
  }
  if (!file.type.startsWith("image/")) throw new Error("That file is not an image.");
  return { image: await rasterToDataUrl(file) };
}

/** Downscale to at most 2560px and re-encode, so a theme stays a small portable file. */
async function rasterToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.88, 0.75, 0.6, 0.45]) {
    const url = canvas.toDataURL("image/webp", quality);
    if (url.length < 5_500_000) return url;
  }
  throw new Error("That image is too large even after compression.");
}
