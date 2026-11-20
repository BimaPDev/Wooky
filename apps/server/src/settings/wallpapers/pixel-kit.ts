import { escapeXml, mulberry32 } from "./scenes.ts";

export const W = 1920;
export const H = 1200;
export const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export type Rgb = [number, number, number];

export function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** One ASCII map plus a palette; "." is always empty. Palette values are #rrggbb or #rrggbbaa. */
export type SpriteDef = { rows: readonly string[]; pal: Readonly<Record<string, string>> };

/** Mutable character grid with a few raster primitives for authoring bigger sprites. */
export class Grid {
  readonly cells: string[][];
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
  }
  set(x: number, y: number, ch: string): void {
    const row = this.cells[Math.round(y)];
    if (row && x >= 0 && x < this.w) row[Math.round(x)] = ch;
  }
  get(x: number, y: number): string {
    return this.cells[y]?.[x] ?? ".";
  }
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    ch: string | ((nx: number, ny: number, x: number, y: number) => string),
  ): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) this.set(x, y, typeof ch === "string" ? ch : ch(nx, ny, x, y));
      }
    }
  }
  poly(
    pts: ReadonlyArray<readonly number[]>,
    ch: string | ((x: number, y: number) => string),
  ): void {
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        let inside = false;
        const px = x + 0.5;
        const py = y + 0.5;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
          const [xi = 0, yi = 0] = pts[i] ?? [];
          const [xj = 0, yj = 0] = pts[j] ?? [];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
            inside = !inside;
        }
        if (inside) this.set(x, y, typeof ch === "string" ? ch : ch(x, y));
      }
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, ch: string, thick = 1): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i += 1) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      for (let dy = 0; dy < thick; dy += 1) {
        for (let dx = 0; dx < thick; dx += 1) this.set(Math.round(x) + dx, Math.round(y) + dy, ch);
      }
    }
  }
  mirrorX(): void {
    for (const row of this.cells) {
      for (let x = 0; x < Math.floor(this.w / 2); x += 1) {
        const left = row[x] as string;
        const right = row[this.w - 1 - x] as string;
        if (left !== "." && right === ".") row[this.w - 1 - x] = left;
        else if (right !== "." && left === ".") row[x] = right;
      }
    }
  }
  rows(): string[] {
    return this.cells.map((r) => r.join(""));
  }
}

const TILE_GLYPHS = "xsnoeadkpuf01{}();=/*:#+<>ilrtcmwvyzqbghj";

type Placed = { w: number; h: number };

/**
 * Tile engine. A sprite is a union of coloured runs painted through one shared rounded-tile
 * mask (the gaps), with a dark or light glyph pattern over each colour. Cost scales with the
 * number of runs, not tiles.
 */
export class PixelKit {
  readonly defs: string[] = [];
  private readonly placed = new Map<string, Placed>();
  readonly pitch: number;

  private readonly rng: () => number;
  private readonly alpha: { dark: number; light: number };
  private readonly made = new Set<string>();

  constructor(pitch: number, seed: number, glyphAlpha = { dark: 0.3, light: 0.34 }) {
    const p = pitch;
    this.pitch = pitch;
    this.rng = mulberry32(seed);
    this.alpha = glyphAlpha;
    this.defs.push(
      `<pattern id="tp" width="${p}" height="${p}" patternUnits="userSpaceOnUse"><rect x="1" y="1" width="${p - 2}" height="${p - 2}" rx="${fmt(p * 0.18)}" fill="#fff"/></pattern>`,
    );
  }

  /** Glyph overlay pattern: one <text> row per tile row, per-glyph x list, so it stays tiny. */
  private glyphPattern(id: "gd" | "gl"): void {
    if (this.made.has(id)) return;
    this.made.add(id);
    const p = this.pitch;
    const cols = 31;
    const rows = 11;
    const lines: string[] = [];
    for (let r = 0; r < rows; r += 1) {
      const xs: string[] = [];
      let chars = "";
      for (let c = 0; c < cols; c += 1) {
        xs.push(fmt(c * p + p / 2));
        chars += TILE_GLYPHS.charAt(Math.floor(this.rng() * TILE_GLYPHS.length));
      }
      lines.push(
        `<text x="${xs.join(" ")}" y="${fmt(r * p + p / 2 + p * 0.26)}">${escapeXml(chars)}</text>`,
      );
    }
    const fill = id === "gd" ? "#000" : "#fff";
    const alpha = id === "gd" ? this.alpha.dark : this.alpha.light;
    this.defs.push(
      `<pattern id="${id}" width="${cols * p}" height="${rows * p}" patternUnits="userSpaceOnUse"><g fill="${fill}" fill-opacity="${alpha}" font-size="${fmt(p * 0.66)}" text-anchor="middle">${lines.join("")}</g></pattern>`,
    );
  }

  /** Registers a sprite under `name` (referenced by `place`). Returns its size in px. */
  sprite(name: string, def: SpriteDef): { w: number; h: number } {
    const p = this.pitch;
    const h = def.rows.length;
    const w = Math.max(...def.rows.map((r) => r.length));
    const colours = new Map<string, string[]>();
    def.rows.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row.charAt(x);
        if (ch === ".") {
          x += 1;
          continue;
        }
        let e = x;
        while (e < row.length && row.charAt(e) === ch) e += 1;
        const list = colours.get(ch) ?? [];
        list.push(`M${x * p} ${y * p}h${(e - x) * p}v${p}h${-(e - x) * p}z`);
        colours.set(ch, list);
        x = e;
      }
    });
    const parts: string[] = [];
    let k = 0;
    for (const [ch, runs] of colours) {
      const colour = def.pal[ch];
      if (!colour) throw new Error(`sprite ${name}: no palette entry for "${ch}"`);
      const pid = `${name}-${k}`;
      k += 1;
      this.defs.push(`<path id="${pid}" d="${runs.join("")}"/>`);
      const opacity = colour.length === 9 ? Number.parseInt(colour.slice(7), 16) / 255 : 1;
      const base = colour.slice(0, 7);
      const op = opacity < 1 ? ` fill-opacity="${opacity.toFixed(2)}"` : "";
      const glyph = luminance(base) > 0.5 ? "gd" : "gl";
      this.glyphPattern(glyph);
      parts.push(
        `<use href="#${pid}" fill="${base}"${op}/><use href="#${pid}" fill="url(#${glyph})"/>`,
      );
    }
    this.defs.push(
      `<mask id="m-${name}" maskUnits="userSpaceOnUse" x="0" y="0" width="${w * p}" height="${h * p}"><rect width="${w * p}" height="${h * p}" fill="url(#tp)"/></mask>`,
      `<g id="${name}" mask="url(#m-${name})">${parts.join("")}</g>`,
    );
    const size = { w: w * p, h: h * p };
    this.placed.set(name, size);
    return size;
  }

  size(name: string): Placed {
    const s = this.placed.get(name);
    if (!s) throw new Error(`unknown sprite ${name}`);
    return s;
  }

  /** `<use>` of a registered sprite at (x, y), optionally mirrored, scaled or faded. */
  place(
    name: string,
    x: number,
    y: number,
    o: { flip?: boolean; scale?: number; opacity?: number } = {},
  ): string {
    const s = o.scale ?? 1;
    const { w } = this.size(name);
    const tf = o.flip
      ? `translate(${fmt(x + w * s)} ${fmt(y)}) scale(${fmt(-s)} ${fmt(s)})`
      : s === 1
        ? `translate(${fmt(x)} ${fmt(y)})`
        : `translate(${fmt(x)} ${fmt(y)}) scale(${fmt(s)})`;
    const op = o.opacity !== undefined && o.opacity < 1 ? ` opacity="${fmt(o.opacity)}"` : "";
    return `<use href="#${name}" transform="${tf}"${op}/>`;
  }
}

const EASE = 'calcMode="spline" keyTimes="0;.5;1" keySplines=".45 0 .55 1;.45 0 .55 1"';

/** Back-and-forth drift of `inner` around (x, y). One animateTransform. */
export function sway(
  inner: string,
  o: { x: number; y: number; dx: number; dy: number; dur: number; begin?: number },
): string {
  const a = `${fmt(o.x)} ${fmt(o.y)}`;
  const b = `${fmt(o.x + o.dx)} ${fmt(o.y + o.dy)}`;
  const begin = o.begin ? ` begin="${fmt(o.begin)}s"` : "";
  return `<g transform="translate(${a})">${inner}<animateTransform attributeName="transform" type="translate" values="${a};${b};${a}" dur="${o.dur}s"${begin} repeatCount="indefinite" ${EASE}/></g>`;
}

/**
 * Travels along one axis from `from` to `to` and wraps. The loop starts at the static position,
 * so the frozen picture matches t=0. `from`/`to` should lie off screen so the wrap is unseen.
 */
export function cross(
  inner: string,
  o: { x: number; y: number; axis?: "x" | "y"; from: number; to: number; dur: number },
): string {
  const vertical = o.axis === "y";
  const phase = ((vertical ? o.y : o.x) - o.from) / (o.to - o.from);
  const begin = -Math.round(phase * o.dur * 10) / 10;
  const at = (v: number) => (vertical ? `${fmt(o.x)} ${fmt(v)}` : `${fmt(v)} ${fmt(o.y)}`);
  return `<g transform="translate(${fmt(o.x)} ${fmt(o.y)})">${inner}<animateTransform attributeName="transform" type="translate" values="${at(o.from)};${at(o.to)}" dur="${o.dur}s" begin="${begin}s" repeatCount="indefinite"/></g>`;
}

/** Opacity breathing between `a` (static value) and `b`. One animate. */
export function pulse(
  inner: string,
  o: { a: number; b: number; dur: number; begin?: number },
): string {
  const begin = o.begin ? ` begin="${fmt(o.begin)}s"` : "";
  return `<g opacity="${fmt(o.a)}">${inner}<animate attributeName="opacity" values="${fmt(o.a)};${fmt(o.b)};${fmt(o.a)}" dur="${o.dur}s"${begin} repeatCount="indefinite" ${EASE}/></g>`;
}

/** Tiny glyph specks scattered on a seeded rng; three opacity bands keep the element count low. */
export function specks(
  rng: () => number,
  o: {
    count: number;
    x0?: number;
    x1?: number;
    y0?: number;
    y1?: number;
    fill: string;
    glyphs?: string;
    size?: number;
    opacity?: number;
    avoid?: { x0: number; x1: number };
  },
): string {
  const glyphs = o.glyphs ?? ".:,'`;*+";
  const bands: Array<{ xs: number[]; ys: number[]; chars: string }> = [0, 1, 2].map(() => ({
    xs: [],
    ys: [],
    chars: "",
  }));
  for (let i = 0; i < o.count; i += 1) {
    const x = (o.x0 ?? 0) + rng() * ((o.x1 ?? W) - (o.x0 ?? 0));
    const y = (o.y0 ?? 0) + rng() * ((o.y1 ?? H) - (o.y0 ?? 0));
    const g = glyphs.charAt(Math.floor(rng() * glyphs.length));
    const band = bands[Math.floor(rng() * 3)];
    if (o.avoid && x > o.avoid.x0 && x < o.avoid.x1 && rng() < 0.6) continue;
    if (!band) continue;
    band.xs.push(Math.round(x));
    band.ys.push(Math.round(y));
    band.chars += g;
  }
  const base = o.opacity ?? 0.4;
  return bands
    .map(
      (b, i) =>
        `<text x="${b.xs.join(" ")}" y="${b.ys.join(" ")}" fill="${o.fill}" font-size="${o.size ?? 9}" opacity="${fmt(base * (0.45 + i * 0.3))}">${escapeXml(b.chars)}</text>`,
    )
    .join("");
}

export type Shaft = { x: number; w: number; op: number };

/** Wide, soft, low-opacity vertical bands. */
export function shafts(
  id: string,
  colour: string,
  list: readonly Shaft[],
): { defs: string; body: string } {
  const defs = `<linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${colour}" stop-opacity="0"/><stop offset=".3" stop-color="${colour}" stop-opacity="1"/><stop offset=".7" stop-color="${colour}" stop-opacity="1"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient>`;
  const body = list
    .map(
      (s) =>
        `<rect x="${s.x}" y="0" width="${s.w}" height="${H}" fill="url(#${id})" opacity="${s.op}"/>`,
    )
    .join("");
  return { defs, body };
}

export function vGradient(id: string, stops: ReadonlyArray<readonly [number, string]>): string {
  return `<linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
}

export function glow(id: string, colour: string, alpha: number): string {
  return `<radialGradient id="${id}"><stop offset="0" stop-color="${colour}" stop-opacity="${alpha}"/><stop offset=".45" stop-color="${colour}" stop-opacity="${fmt(alpha * 0.35)}"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient>`;
}

export function wrapPixelSvg(o: { canvas: string; defs: string; body: string }): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">`,
    `<style>text{font-family:${FONT};user-select:none;white-space:pre}</style>`,
    `<defs>${o.defs}</defs>`,
    `<rect width="${W}" height="${H}" fill="${o.canvas}" />`,
    `<g font-family="${FONT}">${o.body}</g>`,
    `</svg>`,
  ].join("");
}
