// age-allow-file color: theme studio data, not styling. Themes are computed in JS from these hex palettes, and the colour pickers and preview swatches need raw values.
import type { ThemeColorRoles } from "@age/contracts";

type Palette = Record<keyof ThemeColorRoles, string>;

export const WHITE = "#ffffff";
export const BLACK = "#000000";

/** Base palettes every theme starts from. Light mirrors tokens.css; dark is the warm Default theme. */
export const BASE_PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    bg0: "#0d0d0c",
    bg1: "#141413",
    bg2: "#1b1b19",
    bg3: "#242421",
    bgHover: "#2a2a27",
    bgActive: "#31312d",
    line: "#2b2a27",
    lineStrong: "#3a3935",
    text: "#ecebe6",
    text2: "#b4b2aa",
    text3: "#85837b",
    text4: "#5f5d57",
    accent: "#d7c9a7",
    accentInk: "#1a1813",
    focus: "#c9b98f",
    amber: "#e2a54a",
    amberBg: "#2a2114",
    red: "#e5675d",
    redBg: "#2c1716",
    green: "#7cbf86",
    addBg: "#15261a",
    addInk: "#a9d8b0",
    delBg: "#2c1716",
    delInk: "#eba49d",
    providerClaude: "#d98b63",
    providerCursor: "#b9b8b3",
    providerCodex: "#8fb3e6",
    providerDemo: "#a7c79a",
  },
  light: {
    bg0: "#f4f3ef",
    bg1: "#faf9f6",
    bg2: "#ffffff",
    bg3: "#efede7",
    bgHover: "#ebe9e2",
    bgActive: "#e2e0d8",
    line: "#e3e1da",
    lineStrong: "#cfccc3",
    text: "#1d1c1a",
    text2: "#4a4843",
    text3: "#75726b",
    text4: "#a19e96",
    accent: "#3b3528",
    accentInk: "#faf9f6",
    focus: "#8a7444",
    amber: "#b97813",
    amberBg: "#fbf1df",
    red: "#c2392f",
    redBg: "#fbe9e7",
    green: "#2f7d3b",
    addBg: "#e7f4e8",
    addInk: "#1f5e2a",
    delBg: "#fbe9e7",
    delInk: "#8f2a22",
    providerClaude: "#b8653d",
    providerCursor: "#55534e",
    providerCodex: "#3d6fb3",
    providerDemo: "#4f7c43",
  },
};

/** Theme picker wireframe swatches when no matching theme is installed. */
export const WIREFRAME_DEFAULTS = {
  light: {
    canvas: "#f4f3ef",
    sidebar: "#fafafa",
    surface: "#ffffff",
    accentSurface: "#f4f4f5",
    accent: "#7c6a46",
    messageSurface: "#e4e4e7",
    messageAction: "#7c6a46",
  },
  dark: {
    canvas: "#0f0f10",
    sidebar: "#0f0f10",
    surface: "#121212",
    accentSurface: "#27272a",
    accent: "#d7c9a7",
    messageSurface: "#27272a",
    messageAction: "#d7c9a7",
  },
} as const;

/** Hairline ring and drop shadow around a theme preview circle. */
export const PREVIEW_RING = {
  dark: "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)",
  light: "inset 0 0 0 1px rgb(0 0 0 / 0.10), 0 1px 2px rgb(0 0 0 / 0.08)",
} as const;
