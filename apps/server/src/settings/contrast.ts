function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.startsWith("#") ? hex.slice(1) : hex;
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.length === 8
        ? raw.slice(0, 6)
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

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const r = linearChannel(rgb[0]);
  const g = linearChannel(rgb[1]);
  const b = linearChannel(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const LIGHT_INK = "#f3f0ea";
const DARK_INK = "#1c1b18";

/** Primary text colour with at least 4.5:1 contrast on `canvas`. */
export function readableTextOn(canvas: string): string {
  const light = contrastRatio(LIGHT_INK, canvas);
  const dark = contrastRatio(DARK_INK, canvas);
  if (light >= 4.5 && light >= dark) return LIGHT_INK;
  if (dark >= 4.5) return DARK_INK;
  return light >= dark ? LIGHT_INK : DARK_INK;
}
