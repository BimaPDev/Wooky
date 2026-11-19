const CSS_IMPORT_RE = /@import/i;
const CSS_URL_START_RE = /\burl\s*\(/gi;
const CSS_URL_LOCAL_RE =
  /^\s*(?:(?:data:[^)"']+)|#[A-Za-z_][A-Za-z0-9_.:-]*|"#[A-Za-z_][A-Za-z0-9_.:-]*"|'#[A-Za-z_][A-Za-z0-9_.:-]*')\s*\)/;

/** Returns trimmed CSS when it satisfies AGE theme rules; otherwise `null`. */
export function sanitizeThemeCss(css: string | undefined): string | null {
  if (css === undefined || css === "") return "";
  const trimmed = css.trim();
  if (trimmed.length > 50_000) return null;
  if (CSS_IMPORT_RE.test(trimmed)) return null;
  for (const match of trimmed.matchAll(CSS_URL_START_RE)) {
    if (match.index === undefined) continue;
    const after = trimmed.slice(match.index + match[0].length);
    if (!CSS_URL_LOCAL_RE.test(after)) return null;
  }
  return trimmed;
}
