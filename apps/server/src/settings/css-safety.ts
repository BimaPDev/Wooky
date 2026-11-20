import { assertSafeCssSyntax, type CssSafetyProfile } from "./css-syntax.ts";
import { assertSafeSvg } from "./wallpapers/svg-safety.ts";

export type { CssSafetyProfile } from "./css-syntax.ts";

/** Throws when CSS violates Wooky/svg safety rules. */
export function assertSafeCss(
  css: string,
  context: string,
  profile: CssSafetyProfile = "svg",
): void {
  assertSafeCssSyntax(css, context, profile, assertSafeSvg);
}

/** Returns trimmed CSS when it satisfies theme rules; otherwise `null`. */
export function sanitizeThemeCss(css: string | undefined): string | null {
  if (css === undefined || css === "") return "";
  const trimmed = css.trim();
  if (trimmed.length > 50_000) return null;
  try {
    assertSafeCss(trimmed, "Theme css", "theme");
  } catch {
    return null;
  }
  return trimmed;
}
