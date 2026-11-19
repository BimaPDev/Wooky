import type { AppearanceTheme as Theme } from "@age/contracts";
import { assertSafeCss } from "./css-safety.ts";
import { sanitizeThemeCss } from "./theme-css.ts";
import { assertSafeSvg } from "./wallpapers/scenes.ts";

const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";

function validateSvgDataUrl(image: string, context: string): void {
  if (!image.startsWith(SVG_DATA_URL_PREFIX)) return;
  const b64 = image.slice(SVG_DATA_URL_PREFIX.length);
  let svg: string;
  try {
    svg = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    throw new Error(`${context}: invalid SVG data URL.`);
  }
  assertSafeSvg(svg);
}

function validateBackgroundImage(image: string | undefined, context: string): void {
  if (image === undefined) return;
  validateSvgDataUrl(image, context);
}

/** Throws when theme CSS or SVG wallpapers violate safety rules. */
export function validateThemeContent(theme: Theme): void {
  const css = theme.css.trim();
  if (css.length > 0 && sanitizeThemeCss(css) === null) {
    assertSafeCss(css, "Theme css", "theme");
  }

  validateBackgroundImage(theme.background?.image, "Theme background");
  validateBackgroundImage(theme.variants?.dark?.background?.image, "Dark variant background");
  validateBackgroundImage(theme.variants?.light?.background?.image, "Light variant background");
}
