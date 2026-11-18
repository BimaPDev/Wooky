import type { AppearanceTheme, DeviceSettings, ThemeColorRoles } from "@age/contracts";
import { backend } from "./backend.ts";
import { useStore } from "./store.ts";
import { setTheme } from "./theme.ts";
import { BASE_PALETTES as BASE, WHITE } from "./theme-data.ts";

const STYLE_ID = "age-appearance-theme";

type Mode = "dark" | "light";
export type ColorRole = keyof ThemeColorRoles;
type Palette = Record<ColorRole, string>;

export const ROLE_TO_VAR: Record<ColorRole, string> = {
  bg0: "--bg-0",
  bg1: "--bg-1",
  bg2: "--bg-2",
  bg3: "--bg-3",
  bgHover: "--bg-hover",
  bgActive: "--bg-active",
  line: "--line",
  lineStrong: "--line-strong",
  text: "--text",
  text2: "--text-2",
  text3: "--text-3",
  text4: "--text-4",
  accent: "--accent",
  accentInk: "--accent-ink",
  focus: "--focus",
  amber: "--amber",
  amberBg: "--amber-bg",
  red: "--red",
  redBg: "--red-bg",
  green: "--green",
  addBg: "--add-bg",
  addInk: "--add-ink",
  delBg: "--del-bg",
  delInk: "--del-ink",
  providerClaude: "--provider-claude",
  providerCursor: "--provider-cursor",
  providerCodex: "--provider-codex",
  providerDemo: "--provider-demo",
};

export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return a;
  const m = (i: 0 | 1 | 2) => Math.max(0, Math.min(255, Math.round(pa[i] + (pb[i] - pa[i]) * t)));
  return `#${[m(0), m(1), m(2)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.slice(0, 6);
  if (full.length !== 6) return null;
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function linearChannel(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const r = linearChannel(rgb[0]);
  const g = linearChannel(rgb[1]);
  const b = linearChannel(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between a foreground and background colour. */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Full palette for a theme: derived from canvas + accent, then explicit role overrides. */
/** Pick whichever base ink reads better on the accent (higher WCAG contrast). */
export function accentInkFor(accent: string): string {
  const darkInk = BASE.dark.accentInk;
  const lightInk = BASE.light.accentInk;
  return contrastRatio(darkInk, accent) >= contrastRatio(lightInk, accent) ? darkInk : lightInk;
}

export function resolvePalette(theme: AppearanceTheme): Palette {
  const dark = theme.appearance === "dark";
  const base = BASE[theme.appearance];
  const ink = base.text;
  const canvas = theme.canvas;
  const accent = theme.accent;
  const derived: Palette = {
    ...base,
    bg0: canvas,
    bg1: mix(canvas, ink, dark ? 0.04 : 0.02),
    bg2: mix(canvas, ink, dark ? 0.07 : 0.0),
    bg3: mix(canvas, ink, dark ? 0.12 : 0.05),
    bgHover: mix(canvas, ink, dark ? 0.14 : 0.07),
    bgActive: mix(canvas, ink, dark ? 0.18 : 0.1),
    line: mix(canvas, ink, dark ? 0.12 : 0.1),
    lineStrong: mix(canvas, ink, dark ? 0.2 : 0.18),
    text: mix(ink, canvas, 0.02),
    text2: mix(ink, canvas, dark ? 0.26 : 0.3),
    text3: mix(ink, canvas, dark ? 0.45 : 0.5),
    text4: mix(ink, canvas, dark ? 0.62 : 0.66),
    accent,
    accentInk: accentInkFor(accent),
    focus: mix(accent, ink, 0.15),
    amberBg: mix(canvas, base.amber, dark ? 0.14 : 0.1),
    redBg: mix(canvas, base.red, dark ? 0.14 : 0.1),
    addBg: mix(canvas, base.green, dark ? 0.14 : 0.1),
    delBg: mix(canvas, base.red, dark ? 0.14 : 0.1),
  };
  if (!dark) derived.bg2 = mix(canvas, WHITE, 0.7);
  for (const [role, value] of Object.entries(theme.colors)) {
    if (value) derived[role as ColorRole] = value;
  }
  return derived;
}

/** Contrast stretches surfaces, hairlines and muted text away from (or toward) the canvas. */
function applyContrast(palette: Palette, percent: number): Palette {
  if (percent === 100) return palette;
  const k = percent / 100;
  const from = palette.bg0;
  const stretch = (value: string) => mix(from, value, k);
  return {
    ...palette,
    bg1: stretch(palette.bg1),
    bg2: stretch(palette.bg2),
    bg3: stretch(palette.bg3),
    bgHover: stretch(palette.bgHover),
    bgActive: stretch(palette.bgActive),
    line: stretch(palette.line),
    lineStrong: stretch(palette.lineStrong),
    text2: stretch(palette.text2),
    text3: stretch(palette.text3),
    text4: stretch(palette.text4),
  };
}

function alphaHex(hex: string, percent: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const a = Math.round((Math.max(0, Math.min(100, percent)) / 100) * 255);
  return `#${[...rgb, a].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

const DENSITY = { compact: 0.8, cozy: 1, comfortable: 1.2 } as const;

interface Interface {
  appearanceContrast: number;
  glassOpacity: number;
}

/** The whole appearance as one stylesheet. Selectors outrank tokens.css in every mode. */
export function buildAppearanceCss(theme: AppearanceTheme | null, ui: Interface): string {
  const custom = theme && theme.id !== "default" ? theme : null;
  const image = custom?.background?.image;
  const surface = custom?.background?.surfaceOpacity ?? 82;

  const paletteFor = (mode: Mode) => {
    let palette = custom && custom.appearance === mode ? resolvePalette(custom) : BASE[mode];
    palette = applyContrast(palette, ui.appearanceContrast);
    if (image && custom?.appearance === mode) {
      palette = {
        ...palette,
        bg0: alphaHex(palette.bg0, surface),
        bg1: alphaHex(palette.bg1, Math.min(100, surface + 6)),
      };
    }
    return palette;
  };
  const block = (selector: string, mode: Mode) => {
    const vars = Object.entries(paletteFor(mode))
      .map(([role, value]) => `  ${ROLE_TO_VAR[role as ColorRole]}: ${value};`)
      .join("\n");
    return `${selector} {\n  color-scheme: ${mode};\n${vars}\n}`;
  };

  const out = [
    block(`html:root[data-theme="dark"]`, "dark"),
    block(`html:root[data-theme="light"]`, "light"),
    `@media (prefers-color-scheme: dark) {\n${block("html:root:not([data-theme])", "dark")}\n}`,
    `@media (prefers-color-scheme: light) {\n${block("html:root:not([data-theme])", "light")}\n}`,
  ];

  const globals: string[] = [`  --glass-opacity: ${ui.glassOpacity}%;`];
  const fonts = custom?.fonts;
  if (fonts?.ui) globals.push(`  --font-ui: ${fonts.ui}, system-ui, sans-serif;`);
  if (fonts?.mono) globals.push(`  --font-mono: ${fonts.mono}, ui-monospace, monospace;`);
  if (fonts?.size) {
    const s = fonts.size;
    globals.push(
      `  --text-xs: ${s - 2}px;`,
      `  --text-sm: ${s - 1}px;`,
      `  --text-base: ${s}px;`,
      `  --text-md: ${s + 1}px;`,
      `  --text-lg: ${s + 3}px;`,
    );
  }
  const shape = custom?.shape;
  if (shape?.radius !== undefined) {
    const r = shape.radius;
    globals.push(
      `  --radius-sm: ${Math.round(r * 0.66)}px;`,
      `  --radius: ${r}px;`,
      `  --radius-lg: ${Math.round(r * 1.66)}px;`,
      `  --radius-xl: ${Math.round(r * 2.33)}px;`,
    );
  }
  if (shape?.density) {
    const k = DENSITY[shape.density];
    for (const n of [1, 2, 3, 4, 5, 6, 8])
      globals.push(`  --space-${n}: ${Math.round(n * 4 * k)}px;`);
  }
  if (shape?.sidebarWidth) globals.push(`  --sidebar-width: ${shape.sidebarWidth}px;`);
  out.push(`html:root {\n${globals.join("\n")}\n}`);

  if (image && custom) {
    const bg = custom.background ?? {};
    const veil = alphaHex(resolvePalette(custom).bg0, bg.dim ?? 35);
    const blur = bg.blur ?? 0;
    const fit =
      bg.fit === "tile"
        ? "background-repeat: repeat; background-size: auto;"
        : `background-repeat: no-repeat; background-position: center; background-size: ${bg.fit ?? "cover"};`;
    const layer = `{
  content: "";
  position: fixed;
  inset: ${-blur * 2}px;
  z-index: -1;
  pointer-events: none;
  background-image: linear-gradient(${veil}, ${veil}), url("${image}");
  ${fit}
  filter: blur(${blur}px);
}`;
    const mode = custom.appearance;
    const solid = resolvePalette(custom).bg0;
    const rules = (root: string) =>
      [
        `${root} { background-color: ${solid}; }`,
        `${root} body, ${root} .shell, ${root} .workspace, ${root} .workspace-body, ${root} .main { background: transparent; }`,
        `${root}::before ${layer}`,
      ].join(" ");
    out.push(
      rules(`html:root[data-theme="${mode}"]`),
      `@media (prefers-color-scheme: ${mode}) {
${rules("html:root:not([data-theme])")}
}`,
    );
  }

  if (custom?.css.trim()) out.push(custom.css.trim());
  return out.join("\n\n");
}

function interfaceOf(settings: DeviceSettings | null): Interface {
  return {
    appearanceContrast: settings?.appearanceContrast ?? 100,
    glassOpacity: settings?.glassOpacity ?? 80,
  };
}

function writeStyle(css: string) {
  const existing = document.getElementById(STYLE_ID);
  const el = existing ?? document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = css;
  if (!existing) document.head.appendChild(el);
}

export function applyAppearanceTheme(theme: AppearanceTheme | null) {
  const settings = useStore.getState().deviceSettings;
  writeStyle(buildAppearanceCss(theme, interfaceOf(settings)));
  if (settings) document.documentElement.dataset.chatWidth = settings.chatWidth;
  useStore.setState({ activeAppearance: theme });
}

function reapply() {
  applyAppearanceTheme(useStore.getState().activeAppearance);
}

export async function loadDeviceSettings() {
  try {
    const settings = await backend().call("settings.get", {});
    useStore.setState({ deviceSettings: settings });
    applyColorMode(settings.colorMode);
    const theme =
      settings.activeThemeId && settings.activeThemeId !== "default"
        ? await backend().call("themes.get", { id: settings.activeThemeId })
        : null;
    applyAppearanceTheme(theme);
  } catch (error) {
    console.error("Wooky: settings.get failed", error);
  }
}

export function applyColorMode(mode: DeviceSettings["colorMode"]) {
  if (mode === "system") {
    useStore.setState({ theme: null });
    try {
      localStorage.removeItem("age.theme");
    } catch {
      /* ignore */
    }
    return;
  }
  setTheme(mode);
}

export async function patchDeviceSettings(patch: Partial<DeviceSettings>) {
  const settings = await backend().call("settings.put", { settings: patch });
  useStore.setState({ deviceSettings: settings });
  if (patch.colorMode) applyColorMode(settings.colorMode);
  if (patch.activeThemeId !== undefined) {
    const theme =
      settings.activeThemeId === "default"
        ? null
        : await backend().call("themes.get", { id: settings.activeThemeId });
    applyAppearanceTheme(theme);
  } else reapply();
  return settings;
}

/** Activate a theme and switch the colour mode to match it, so it is actually visible. */
export async function activateTheme(id: string, appearance: Mode) {
  const settings = useStore.getState().deviceSettings;
  const systemMode: Mode = window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
  const effective = settings?.colorMode === "system" ? systemMode : settings?.colorMode;
  const patch: Partial<DeviceSettings> = { activeThemeId: id };
  if (id !== "default" && effective !== appearance) patch.colorMode = appearance;
  return patchDeviceSettings(patch);
}

export async function listThemes() {
  return backend().call("themes.list", {});
}

export async function getTheme(id: string) {
  return backend().call("themes.get", { id });
}

export async function saveTheme(theme: AppearanceTheme) {
  const saved = await backend().call("themes.put", { theme });
  const active = useStore.getState().deviceSettings?.activeThemeId;
  if (active === saved.id) applyAppearanceTheme(saved);
  return saved;
}

export async function deleteTheme(id: string) {
  const result = await backend().call("themes.delete", { id });
  await loadDeviceSettings();
  return result;
}

/** Live preview while editing; `restoreSavedTheme` undoes it. */
export function previewThemeLocally(theme: AppearanceTheme) {
  writeStyle(buildAppearanceCss(theme, interfaceOf(useStore.getState().deviceSettings)));
  document.documentElement.dataset.theme = theme.appearance;
}

export function restoreSavedTheme() {
  const mode = useStore.getState().theme;
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  reapply();
}
