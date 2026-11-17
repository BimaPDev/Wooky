import { z } from "zod";
import { ProviderKind } from "./model.ts";

/** Hex color like #rgb or #rrggbb / #rrggbbaa. */
export const HexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected a hex color");

/**
 * Optional overrides for AGE CSS variables (without the leading --).
 * Prefer canvas + accent; fill colors only when a role needs a special value.
 */
export const ThemeColorRoles = z
  .object({
    bg0: HexColor.optional(),
    bg1: HexColor.optional(),
    bg2: HexColor.optional(),
    bg3: HexColor.optional(),
    bgHover: HexColor.optional(),
    bgActive: HexColor.optional(),
    line: HexColor.optional(),
    lineStrong: HexColor.optional(),
    text: HexColor.optional(),
    text2: HexColor.optional(),
    text3: HexColor.optional(),
    text4: HexColor.optional(),
    accent: HexColor.optional(),
    accentInk: HexColor.optional(),
    focus: HexColor.optional(),
    amber: HexColor.optional(),
    amberBg: HexColor.optional(),
    red: HexColor.optional(),
    redBg: HexColor.optional(),
    green: HexColor.optional(),
    addBg: HexColor.optional(),
    addInk: HexColor.optional(),
    delBg: HexColor.optional(),
    delInk: HexColor.optional(),
    providerClaude: HexColor.optional(),
    providerCursor: HexColor.optional(),
    providerCodex: HexColor.optional(),
    providerDemo: HexColor.optional(),
  })
  .strict();
export type ThemeColorRoles = z.infer<typeof ThemeColorRoles>;

/** A CSS font-family list. No characters that could end the declaration. */
const FontStack = z
  .string()
  .max(200)
  .regex(/^[^;{}<>\\]*$/, "Font list cannot contain ; { } < > or \\");

export const ThemeFonts = z
  .object({
    ui: FontStack.optional(),
    mono: FontStack.optional(),
    /** Base UI text size in px; the other sizes scale from it. */
    size: z.number().int().min(11).max(18).optional(),
  })
  .strict();
export type ThemeFonts = z.infer<typeof ThemeFonts>;

export const ThemeShape = z
  .object({
    /** Base corner radius in px; small/large radii scale from it. */
    radius: z.number().min(0).max(20).optional(),
    density: z.enum(["compact", "cozy", "comfortable"]).optional(),
    sidebarWidth: z.number().int().min(220).max(420).optional(),
  })
  .strict();
export type ThemeShape = z.infer<typeof ThemeShape>;

/** Inline image only (data: URL), so themes stay one portable JSON file. */
export const ThemeImage = z
  .string()
  .max(6_000_000)
  .regex(
    /^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+=*$/,
    "Background must be a base64 PNG, JPEG, WebP, GIF or AVIF data URL",
  );

export const ThemeBackground = z
  .object({
    image: ThemeImage.optional(),
    fit: z.enum(["cover", "contain", "tile"]).optional(),
    /** 0-90: canvas-coloured veil over the image. */
    dim: z.number().int().min(0).max(90).optional(),
    blur: z.number().int().min(0).max(40).optional(),
    /** 0-100: how solid app surfaces are over the image. */
    surfaceOpacity: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type ThemeBackground = z.infer<typeof ThemeBackground>;

export const AppearanceTheme = z.object({
  version: z.literal(1).default(1),
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Theme id: lowercase letters, digits, _ or -"),
  name: z.string().min(1).max(80),
  appearance: z.enum(["dark", "light"]),
  /** Base surface; derives bg layers when colors are sparse. */
  canvas: HexColor,
  /** Accent; derives focus / accentInk when colors are sparse. */
  accent: HexColor,
  colors: ThemeColorRoles.default({}),
  fonts: ThemeFonts.optional(),
  shape: ThemeShape.optional(),
  background: ThemeBackground.optional(),
  /** Extra CSS after variables. No @import; url() only with data: or #. Max 50k. */
  css: z.string().max(50_000).default(""),
  builtin: z.boolean().optional(),
});
export type AppearanceTheme = z.infer<typeof AppearanceTheme>;

export const AppearanceThemeSummary = z.object({
  id: z.string(),
  name: z.string(),
  appearance: z.enum(["dark", "light"]),
  canvas: HexColor,
  accent: HexColor,
  builtin: z.boolean(),
  hasCss: z.boolean(),
});
export type AppearanceThemeSummary = z.infer<typeof AppearanceThemeSummary>;

export const DeviceSettings = z.object({
  activeThemeId: z.string().default("default"),
  /** light / dark force a mode; system follows OS (and the theme's appearance when set). */
  colorMode: z.enum(["dark", "light", "system"]).default("system"),
  /** T3-style interface contrast (percent). */
  appearanceContrast: z.number().int().min(50).max(150).default(100),
  /** T3-style glass solidity for menus/dialogs (percent). */
  glassOpacity: z.number().int().min(40).max(100).default(80),
  chatWidth: z.enum(["comfortable", "wide", "full"]).default("comfortable"),
  threadNotifications: z.enum(["off", "banner"]).default("banner"),
  inAppNotifications: z.boolean().default(true),
  projectGrouping: z.boolean().default(true),
  confirmDelete: z.boolean().default(true),
  confirmArchive: z.boolean().default(true),
  /** Providers the user turned off in Settings → Providers. */
  disabledProviders: z.array(ProviderKind).default([]),
  /** Sending while a turn runs: queue the prompt, or keep the composer blocked. */
  followUp: z.enum(["queue", "off"]).default("queue"),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;
