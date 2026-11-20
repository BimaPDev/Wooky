export type CssSafetyProfile = "svg" | "theme";

export type SvgValidator = (svg: string) => void;

const URL_AFTER_SVG = /^\s*(?:#[-A-Za-z0-9_.:]+|"#[-A-Za-z0-9_.:]+"|'#[-A-Za-z0-9_.:]+')/;
const FRAGMENT_RE = /^#[-A-Za-z0-9_.:]+$/;
const THEME_DATA_URL_RE = /^data:image\/(svg\+xml|png|jpeg|gif|webp|avif)(;[^,]*)?,/i;

function readUrlArgument(after: string, context: string): string {
  let i = 0;
  while (i < after.length && /[\t\n\r\f ]/.test(after.charAt(i))) i += 1;
  const quote = after.charAt(i);
  if (quote === '"' || quote === "'") {
    i += 1;
    const start = i;
    while (i < after.length && after.charAt(i) !== quote) i += 1;
    if (i >= after.length) {
      throw new Error(`${context} url() has an unterminated quoted argument.`);
    }
    return after.slice(start, i);
  }
  const start = i;
  while (i < after.length && after.charAt(i) !== ")") i += 1;
  return after.slice(start, i).trim();
}

function decodeDataUrlBody(body: string, params: string): string {
  if (params.toLowerCase().includes("base64")) {
    return Buffer.from(body, "base64").toString("utf8");
  }
  return body.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function assertSafeThemeUrl(after: string, context: string, validateSvg: SvgValidator): void {
  const target = readUrlArgument(after, context);
  if (FRAGMENT_RE.test(target)) return;
  const dataUrl = THEME_DATA_URL_RE.exec(target);
  if (!dataUrl) {
    throw new Error(`${context} url() may only reference allowed local targets.`);
  }
  const subtype = (dataUrl[1] ?? "").toLowerCase();
  if (subtype !== "svg+xml") return;
  const svg = decodeDataUrlBody(target.slice(dataUrl[0].length), dataUrl[2] ?? "");
  validateSvg(svg);
}

/** Throws when CSS violates Wooky/svg syntax rules. */
export function assertSafeCssSyntax(
  css: string,
  context: string,
  profile: CssSafetyProfile = "svg",
  validateSvg: SvgValidator = () => {},
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
  const urlRe = /\burl\s*\(/gi;
  for (const match of css.matchAll(urlRe)) {
    if (match.index === undefined) continue;
    const after = css.slice(match.index + match[0].length);
    if (profile === "svg") {
      if (!URL_AFTER_SVG.test(after)) {
        throw new Error(`${context} url() may only reference allowed local targets.`);
      }
    } else {
      assertSafeThemeUrl(after, context, validateSvg);
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
