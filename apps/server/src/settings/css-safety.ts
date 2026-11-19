export type CssSafetyProfile = "svg" | "theme";

const URL_AFTER_SVG = /^\s*(?:#[-A-Za-z0-9_.:]+|"#[-A-Za-z0-9_.:]+"|'#[-A-Za-z0-9_.:]+')/;
const URL_AFTER_THEME =
  /^\s*(?:(?:data:[^)"']+)|#[-A-Za-z0-9_.:]+|"#[-A-Za-z0-9_.:]+"|'#[-A-Za-z0-9_.:]+')/;

function urlPattern(profile: CssSafetyProfile): RegExp {
  return profile === "svg" ? URL_AFTER_SVG : URL_AFTER_THEME;
}

/** Throws when CSS violates Wooky/svg safety rules. */
export function assertSafeCss(
  css: string,
  context: string,
  profile: CssSafetyProfile = "svg",
): void {
  if (css.includes("\\")) {
    throw new Error(`${context} must not contain backslashes.`);
  }
  const lower = css.toLowerCase();
  if (/@import\b/.test(lower)) {
    throw new Error(`${context} must not contain @import.`);
  }
  if (/@font-face\b/.test(lower)) {
    throw new Error(`${context} must not contain @font-face.`);
  }
  if (/\bimage-set\s*\(/.test(lower)) {
    throw new Error(`${context} must not contain image-set().`);
  }
  if (/\belement\s*\(/.test(lower)) {
    throw new Error(`${context} must not contain element().`);
  }
  if (/\bcross-fade\s*\(/.test(lower)) {
    throw new Error(`${context} must not contain cross-fade().`);
  }
  if (/\bexpression\s*\(/.test(lower)) {
    throw new Error(`${context} must not contain expression().`);
  }
  if (/javascript\s*:/.test(lower)) {
    throw new Error(`${context} must not contain javascript: URLs.`);
  }
  const afterUrl = urlPattern(profile);
  const urlRe = /\burl\s*\(/gi;
  for (const match of css.matchAll(urlRe)) {
    if (match.index === undefined) continue;
    const after = css.slice(match.index + match[0].length);
    if (!afterUrl.test(after)) {
      throw new Error(`${context} url() may only reference allowed local targets.`);
    }
  }
}

/** Scan an SVG attribute value for javascript: and url() payloads. */
export function assertSafeSvgAttributeValue(value: string, context: string): void {
  if (/javascript\s*:/i.test(value)) {
    throw new Error(`Unsafe SVG: ${context} must not contain javascript: URLs.`);
  }
  const urlRe = /\burl\s*\(/gi;
  for (const match of value.matchAll(urlRe)) {
    if (match.index === undefined) continue;
    const after = value.slice(match.index + match[0].length);
    if (!URL_AFTER_SVG.test(after)) {
      throw new Error(`Unsafe SVG: ${context} url() may only reference local # fragments.`);
    }
  }
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
