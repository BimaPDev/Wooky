import type {
  AppearanceTheme,
  DeviceSettings,
  ThemeColorRoles,
  ThemesPush,
} from "@wooky/contracts";
import { backend } from "./backend.ts";
import { LruCache } from "./lru.ts";
import { useStore } from "./store.ts";
import { setTheme, syncRootThemeClass } from "./theme.ts";
import { BASE_PALETTES as BASE, WHITE } from "./theme-data.ts";

const STYLE_ID = "age-appearance-theme";
const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";
const FREEZE_SVG_CSS = "*{animation:none!important;transition:none!important}";
const SMIL_TAGS = ["animate", "animateTransform", "animateMotion", "set"] as const;

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
  providerOpencode: "--provider-opencode",
  providerAcp: "--provider-acp",
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

/** Pick whichever base ink reads better on the accent (higher WCAG contrast). */
export function accentInkFor(accent: string): string {
  const darkInk = BASE.dark.accentInk;
  const lightInk = BASE.light.accentInk;
  return contrastRatio(darkInk, accent) >= contrastRatio(lightInk, accent) ? darkInk : lightInk;
}

/**
 * When the effective colour mode differs from theme.appearance and a matching
 * variant exists, replace canvas, accent, colors and background with the
 * variant's values while keeping fonts, shape and css from the theme.
 */
export function resolveThemeVariant(theme: AppearanceTheme, mode: Mode): AppearanceTheme {
  const variant = mode !== theme.appearance ? theme.variants?.[mode] : undefined;
  if (!variant) return theme;
  return {
    ...theme,
    appearance: mode,
    canvas: variant.canvas,
    accent: variant.accent,
    colors: variant.colors,
    background: variant.background,
  };
}

/** Full palette for a theme: derived from canvas + accent, then explicit role overrides. */
export function resolvePalette(theme: AppearanceTheme, mode: Mode = theme.appearance): Palette {
  const resolved = resolveThemeVariant(theme, mode);
  const dark = resolved.appearance === "dark";
  const base = BASE[resolved.appearance];
  const ink = base.text;
  const canvas = resolved.canvas;
  const accent = resolved.accent;
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
  for (const [role, value] of Object.entries(resolved.colors)) {
    if (value) derived[role as ColorRole] = value;
  }
  return derived;
}

export const STILL_IMAGE_CACHE_LIMIT = 8;
export const stillImageCache = new LruCache<string | null>(STILL_IMAGE_CACHE_LIMIT);

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function freezeSvgWithDomParser(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (
    !root ||
    root.nodeName.toLowerCase() === "parsererror" ||
    doc.getElementsByTagName("parsererror").length > 0
  ) {
    return null;
  }
  for (const tag of SMIL_TAGS) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      el.remove();
    }
  }
  const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = FREEZE_SVG_CSS;
  root.appendChild(style);
  return new XMLSerializer().serializeToString(doc);
}

function freezeSvgFallback(svg: string): string | null {
  const withoutSelfClosing = svg.replace(
    /<(animate|animateTransform|animateMotion|set)\b[^>]*\/\s*>/g,
    "",
  );
  const withoutSmil = withoutSelfClosing.replace(
    /<(animate|animateTransform|animateMotion|set)\b[^>]*>[\s\S]*?<\/\1\s*>/g,
    "",
  );
  const styleTag = `<style>${FREEZE_SVG_CSS}</style>`;
  if (/<\/svg\s*>/i.test(withoutSmil)) {
    return withoutSmil.replace(/<\/svg\s*>/i, `${styleTag}</svg>`);
  }
  if (/<svg\b[^>]*\/\s*>/i.test(withoutSmil)) {
    return withoutSmil.replace(/\/\s*>$/, `>${styleTag}</svg>`);
  }
  return null;
}

function freezeSvgMarkup(svg: string): string | null {
  const hasDomParser = typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined";
  if (hasDomParser) {
    try {
      const parsed = freezeSvgWithDomParser(svg);
      if (parsed !== null) return parsed;
    } catch {
      /* ignore */
    }
  }
  try {
    return freezeSvgFallback(svg);
  } catch {
    return null;
  }
}

/**
 * Strip SMIL animation elements and disable CSS animations/transitions inside
 * a base64 SVG data URL. Memoized per input. Returns null when the still
 * cannot be produced — never the animated original.
 */
export function stillSvgDataUrl(dataUrl: string): string | null {
  if (!dataUrl.startsWith(SVG_DATA_URL_PREFIX)) return dataUrl;
  const cached = stillImageCache.get(dataUrl);
  if (cached !== undefined) return cached;

  try {
    const rawSvg = decodeBase64Utf8(dataUrl.slice(SVG_DATA_URL_PREFIX.length));
    const stillSvg = freezeSvgMarkup(rawSvg);
    if (stillSvg === null) {
      stillImageCache.set(dataUrl, null);
      return null;
    }
    const encoded = `${SVG_DATA_URL_PREFIX}${encodeBase64Utf8(stillSvg)}`;
    stillImageCache.set(dataUrl, encoded);
    return encoded;
  } catch {
    stillImageCache.set(dataUrl, null);
    return null;
  }
}

async function blobToPngDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

async function rasterToPngDataUrl(bitmap: ImageBitmap): Promise<string | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blobToPngDataUrl(blob);
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  return canvas.toDataURL("image/png");
}

/** First-frame PNG data URL for an animated raster wallpaper. Memoized; null on failure. */
export async function stillRasterDataUrl(dataUrl: string): Promise<string | null> {
  const cached = stillImageCache.get(dataUrl);
  if (cached !== undefined) return cached;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const still = await rasterToPngDataUrl(bitmap);
      stillImageCache.set(dataUrl, still);
      return still;
    } finally {
      bitmap.close();
    }
  } catch {
    stillImageCache.set(dataUrl, null);
    return null;
  }
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

const DENSITY = { compact: 0.8, cozy: 1, comfortable: 1.2 } as const;

interface Interface {
  appearanceContrast: number;
  glassOpacity: number;
}

function glassRules(root: string): string {
  return [
    `${root} body, ${root} .shell, ${root} .topbar, ${root} .workspace-body, ${root} .main, ${root} .panel, ${root} .terminal-pane, ${root} .settings-shell, ${root} .settings-main, ${root} .usage-shell, ${root} .usage-topbar { background: transparent; }`,
    `${root} .sidebar, ${root} [data-workspace-area="sidebar"], ${root} .terminal-dock, ${root} .settings-nav { background: color-mix(in srgb, var(--bg-0) var(--surface-opacity, 82%), transparent); }`,
    `${root} .workspace, ${root} .modal.app-route-modal { background: color-mix(in srgb, var(--bg-1) var(--surface-opacity, 82%), transparent); }`,
    `${root} .composer-box, ${root} .popover, ${root} .composer-menu, ${root} .usage-filter-menu, ${root} .usage-info-popover, ${root} .modal:not(.app-route-modal) { background: color-mix(in srgb, var(--bg-2) var(--surface-opacity, 82%), transparent); }`,
    `@supports (backdrop-filter: blur(1px)) {\n  ${root} .sidebar, ${root} [data-workspace-area="sidebar"], ${root} .workspace, ${root} .composer-box, ${root} .popover, ${root} .composer-menu, ${root} .usage-filter-menu, ${root} .usage-info-popover, ${root} .modal {\n    -webkit-backdrop-filter: blur(var(--panel-blur, 0px));\n    backdrop-filter: blur(var(--panel-blur, 0px));\n  }\n}`,
  ].join("\n");
}

/** The whole appearance as one stylesheet. Selectors outrank tokens.css in every mode. */
export function buildAppearanceCss(theme: AppearanceTheme | null, ui: Interface): string {
  const custom = theme && theme.id !== "default" ? theme : null;
  const resolvedFor = (mode: Mode) => (custom ? resolveThemeVariant(custom, mode) : null);

  const paletteFor = (mode: Mode) => {
    const resolved = resolvedFor(mode);
    const palette = resolved ? resolvePalette(resolved) : BASE[mode];
    return applyContrast(palette, ui.appearanceContrast);
  };

  const block = (selector: string, mode: Mode) => {
    const resolved = resolvedFor(mode);
    const scheme = resolved ? resolved.appearance : mode;
    const lines = Object.entries(paletteFor(mode)).map(
      ([role, value]) => `  ${ROLE_TO_VAR[role as ColorRole]}: ${value};`,
    );
    const bg = resolved?.background;
    if (bg?.image) {
      lines.push(
        `  --surface-opacity: ${bg.surfaceOpacity ?? 82}%;`,
        `  --panel-blur: ${bg.panelBlur ?? 0}px;`,
      );
    }
    return `${selector} {\n  color-scheme: ${scheme};\n${lines.join("\n")}\n}`;
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

  for (const mode of ["dark", "light"] as const) {
    if (resolvedFor(mode)?.background?.image) {
      out.push(
        glassRules(`html:root[data-theme="${mode}"]`),
        `@media (prefers-color-scheme: ${mode}) {\n${glassRules("html:root:not([data-theme])")}\n}`,
      );
    }
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
  if (typeof document === "undefined") return;
  const existing = document.getElementById(STYLE_ID);
  const el = existing ?? document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = css;
  if (!existing) document.head.appendChild(el);
}

export function applyAppearanceTheme(theme: AppearanceTheme | null) {
  const { deviceSettings, previewAppearance } = useStore.getState();
  if (previewAppearance === null) {
    writeStyle(buildAppearanceCss(theme, interfaceOf(deviceSettings)));
  }
  if (deviceSettings && typeof document !== "undefined") {
    document.documentElement.dataset.chatWidth = deviceSettings.chatWidth;
  }
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

let themesPushGeneration = 0;

/** Handle server `{ push: "themes", activeThemeId, changedIds }` notifications. */
export async function handleThemesPush(push: ThemesPush) {
  const token = ++themesPushGeneration;
  try {
    const prev = useStore.getState();
    const prevActiveId =
      prev.deviceSettings?.activeThemeId ?? prev.activeAppearance?.id ?? "default";
    const [, settings] = await Promise.all([
      backend().call("themes.list", {}),
      backend().call("settings.get", {}),
    ]);
    if (token !== themesPushGeneration) return;
    useStore.setState({ deviceSettings: settings });
    applyColorMode(settings.colorMode);
    const nextId = settings.activeThemeId || push.activeThemeId || "default";
    if (nextId === "default") {
      applyAppearanceTheme(null);
      return;
    }
    const activeChanged =
      nextId !== prevActiveId ||
      push.activeThemeId !== prevActiveId ||
      prev.activeAppearance?.id !== nextId;
    if (activeChanged || push.changedIds.includes(nextId)) {
      const theme = await backend().call("themes.get", { id: nextId });
      if (token !== themesPushGeneration) return;
      applyAppearanceTheme(theme);
    } else {
      applyAppearanceTheme(prev.activeAppearance);
    }
  } catch (error) {
    if (token !== themesPushGeneration) return;
    console.error("Wooky: themes push sync failed", error);
  }
}

export function applyColorMode(mode: DeviceSettings["colorMode"]) {
  if (mode === "system") {
    useStore.setState({ theme: null });
    syncRootThemeClass(null);
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
  // `settings.put` parses its patch with `DeviceSettings.partial()`, which still fills defaults
  // for absent keys and so resets them on the server. Sending every key keeps them.
  const current = useStore.getState().deviceSettings;
  const settings = await backend().call("settings.put", { settings: { ...current, ...patch } });
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
  const systemMode: Mode =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
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
  useStore.setState({ previewAppearance: theme });
  syncRootThemeClass(theme.appearance);
}

export function restoreSavedTheme() {
  useStore.setState({ previewAppearance: null });
  syncRootThemeClass(useStore.getState().theme);
  reapply();
}
