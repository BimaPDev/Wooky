import {
  H,
  W,
  fmt,
  glow,
  pulse,
  shafts,
  specks,
  sway,
  vGradient,
  wrapPixelSvg,
} from "./pixel-kit.ts";
import { escapeXml, mulberry32, type WallpaperScene } from "./scenes.ts";

// Glyphscape: a dim landscape painted entirely in code glyphs. Each depth gets its own text
// field (smaller and denser far away, bigger and sparser near), clipped to a ridge line and
// tinted by a gradient, so it reads as a picture from across the room and as text up close.

type Palette = {
  canvas: string;
  sky: ReadonlyArray<readonly [number, string]>;
  glow: string;
  glowAlpha: number;
  auroraA: string;
  auroraB: string;
  auroraAlpha: number;
  star: string;
  skyInk: string;
  skyInkAlpha: number;
  far: { solid: string; top: string; bottom: string; alpha: number; rim: string; rimAlpha: number };
  mid: { solid: string; top: string; bottom: string; alpha: number; rim: string; rimAlpha: number };
  near: {
    solid: string;
    top: string;
    bottom: string;
    alpha: number;
    rim: string;
    rimAlpha: number;
  };
  warm: string;
  mist: string;
  shaft: string;
  shaftOp: number;
  calm: string;
};

const DARK: Palette = {
  canvas: "#0a0e16",
  sky: [
    [0, "#070a13"],
    [0.4, "#0f1625"],
    [0.66, "#1d2138"],
    [0.8, "#33283a"],
    [1, "#120d12"],
  ],
  glow: "#ee9560",
  glowAlpha: 0.42,
  auroraA: "#4fe3bb",
  auroraB: "#8b7cf2",
  auroraAlpha: 0.26,
  star: "#cfd8ff",
  skyInk: "#7f90bd",
  skyInkAlpha: 0.075,
  far: {
    solid: "#121a2c",
    top: "#8fa4d8",
    bottom: "#3b4b7a",
    alpha: 0.55,
    rim: "#c3d2fa",
    rimAlpha: 0.5,
  },
  mid: {
    solid: "#0d1322",
    top: "#7a8cc0",
    bottom: "#33406c",
    alpha: 0.6,
    rim: "#f2b48c",
    rimAlpha: 0.55,
  },
  near: {
    solid: "#080c15",
    top: "#5a6b9e",
    bottom: "#27325a",
    alpha: 0.6,
    rim: "#8fa1d6",
    rimAlpha: 0.45,
  },
  warm: "#f2a070",
  mist: "#e08a5c",
  shaft: "#9fb4ff",
  shaftOp: 0.045,
  calm: "#0a0e16",
};

const LIGHT: Palette = {
  canvas: "#eee7d9",
  sky: [
    [0, "#cbd6e4"],
    [0.4, "#e3e3de"],
    [0.68, "#f3dcc4"],
    [0.82, "#f0cdb0"],
    [1, "#dfcab6"],
  ],
  glow: "#ff9d5c",
  glowAlpha: 0.5,
  auroraA: "#52c9b0",
  auroraB: "#9d90ee",
  auroraAlpha: 0.28,
  star: "#6a7aa8",
  skyInk: "#4d5d8c",
  skyInkAlpha: 0.09,
  far: {
    solid: "#c6cddb",
    top: "#3d4d7c",
    bottom: "#8795bf",
    alpha: 0.6,
    rim: "#2a3764",
    rimAlpha: 0.45,
  },
  mid: {
    solid: "#b4b4c6",
    top: "#35416c",
    bottom: "#7683ad",
    alpha: 0.62,
    rim: "#c25f2c",
    rimAlpha: 0.5,
  },
  near: {
    solid: "#a59ba9",
    top: "#2a3358",
    bottom: "#56628c",
    alpha: 0.62,
    rim: "#2a3358",
    rimAlpha: 0.35,
  },
  warm: "#d8703a",
  mist: "#ffb27a",
  shaft: "#ffffff",
  shaftOp: 0.22,
  calm: "#eee7d9",
};

const TOKENS = [
  "const",
  "let",
  "await",
  "return",
  "if",
  "else",
  "for",
  "map",
  "git",
  "diff",
  "agent",
  "worktree",
  "commit",
  "branch",
  "push",
  "async",
  "import",
  "export",
  "type",
  "true",
  "false",
  "null",
  "void",
  "new",
  "this",
  "state",
  "event",
  "queue",
  "turn",
  "thread",
  "stream",
  "parse",
  "emit",
  "wait",
  "run",
  "fn",
  "ok",
  "err",
  "key",
  "val",
  "idx",
  "len",
  "buf",
  "ctx",
  "cfg",
  "env",
  "src",
  "dst",
];
const PUNCT = [
  "{",
  "}",
  "(",
  ")",
  ";",
  "=",
  "=>",
  "<",
  ">",
  "/",
  "*",
  ".",
  ":",
  "</>",
  "();",
  "{}",
  "//",
  "&&",
  "||",
  "[]",
  "+=",
];

function codeRow(rng: () => number, length: number, density: number): string {
  let row = "";
  while (row.length < length) {
    const r = rng();
    if (r > density) {
      row += " ".repeat(2 + Math.floor(rng() * 6));
      continue;
    }
    row +=
      r < density * 0.62
        ? TOKENS[Math.floor(rng() * TOKENS.length)]
        : PUNCT[Math.floor(rng() * PUNCT.length)];
    row += rng() < 0.55 ? "." : rng() < 0.5 ? " " : "";
  }
  return row.slice(0, length);
}

function field(
  id: string,
  o: { y0: number; y1: number; size: number; pitch: number; density: number; seed: number },
): string {
  const rng = mulberry32(o.seed);
  const chars = Math.round(1960 / (o.size * 0.6));
  const rows: string[] = [];
  for (let y = o.y0; y < o.y1; y += o.pitch) {
    rows.push(
      `<text x="0" y="${y}" textLength="1960" lengthAdjust="spacing">${escapeXml(codeRow(rng, chars, o.density))}</text>`,
    );
  }
  return `<g id="${id}" xml:space="preserve" font-size="${o.size}">${rows.join("")}</g>`;
}

type Ridge = (x: number) => number;

function ridged(seed: number, base: number, amp: number, sharp: number): Ridge {
  const rng = mulberry32(seed);
  const waves = [0, 1, 2, 3, 4].map((k) => ({
    f: (0.0032 + k * 0.0041) * (0.8 + rng() * 0.5),
    a: 1 / (1 + k * 0.9),
    p: rng() * 6.28,
  }));
  const total = waves.reduce((s, w) => s + w.a, 0);
  return (x) => {
    let v = 0;
    for (const w of waves) {
      const s = Math.sin(x * w.f + w.p);
      v += w.a * (sharp * (1 - Math.abs(s)) * 2 - sharp + (1 - sharp) * s);
    }
    return base - (v / total) * amp;
  };
}

function ridgePoints(r: Ridge, step = 24): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let x = -step; x <= W + step; x += step) pts.push([x, Math.round(r(x))]);
  return pts;
}

function area(pts: Array<[number, number]>, bottom: number): string {
  return `M${pts.map(([x, y]) => `${x} ${y}`).join("L")}L${W + 24} ${bottom}L-24 ${bottom}Z`;
}

function band(pts: Array<[number, number]>, depth: number): string {
  const top = pts.map(([x, y]) => `${x} ${y}`).join("L");
  const low = [...pts]
    .reverse()
    .map(([x, y]) => `${x} ${y + depth}`)
    .join("L");
  return `M${top}L${low}Z`;
}

/** Aurora as a comb of soft vertical rays; each ray fades in and out through its own gradient. */
function curtain(seed: number, x0: number, x1: number, y: number, h: number, fill: string): string {
  const rng = mulberry32(seed);
  const p1 = rng() * 6;
  const p2 = rng() * 6;
  const rays: string[] = [];
  for (let x = x0; x < x1; x += 22) {
    const t = (x - x0) / (x1 - x0);
    const fade = Math.sin(t * Math.PI) ** 0.8;
    const top = y + Math.sin(x * 0.006 + p1) * 70 + Math.sin(x * 0.015 + p2) * 22 - fade * 34;
    const height = h * (0.35 + 0.65 * fade) * (0.75 + rng() * 0.25);
    rays.push(`<rect x="${x}" y="${Math.round(top)}" width="24" height="${Math.round(height)}"/>`);
  }
  return `<g fill="${fill}">${rays.join("")}</g>`;
}

export function buildGlyphscape(mode: "dark" | "light"): string {
  const P = mode === "dark" ? DARK : LIGHT;
  const rng = mulberry32(mode === "dark" ? 0x61f5 : 0x61f6);

  const far = ridgePoints(ridged(11, 600, 210, 0.7), 20);
  const mid = ridgePoints(ridged(23, 760, 150, 0.35), 24);
  const near = ridgePoints(ridged(37, 930, 105, 0.12), 28);

  const gradient = (id: string, top: number, bottom: number, c0: string, c1: string) =>
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${bottom}"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`;

  const shaft = shafts("shaft", P.shaft, [
    { x: 330, w: 320, op: P.shaftOp },
    { x: 980, w: 240, op: P.shaftOp * 0.7 },
    { x: 1450, w: 400, op: P.shaftOp * 0.9 },
  ]);

  const defs = [
    shaft.defs,
    glow("hglow", P.glow, P.glowAlpha),
    `<linearGradient id="auG" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${P.auroraB}" stop-opacity="0"/><stop offset=".35" stop-color="${P.auroraB}" stop-opacity="${P.auroraAlpha}"/><stop offset=".7" stop-color="${P.auroraA}" stop-opacity="${P.auroraAlpha}"/><stop offset="1" stop-color="${P.auroraA}" stop-opacity="0"/></linearGradient>`,
    `<linearGradient id="auM" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".4" stop-color="#fff" stop-opacity=".95"/><stop offset=".75" stop-color="#fff" stop-opacity=".7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    `<mask id="auMask" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${curtain(5, 200, 1180, 190, 250, "url(#auM)")}${curtain(9, 760, 1740, 120, 220, "url(#auM)")}</mask>`,
    `<radialGradient id="gmG" gradientUnits="userSpaceOnUse" cx="560" cy="720" r="820"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`,
    `<mask id="gm" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#gmG)"/></mask>`,
    `<linearGradient id="mist" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${P.mist}" stop-opacity="0"/><stop offset=".5" stop-color="${P.mist}"/><stop offset="1" stop-color="${P.mist}" stop-opacity="0"/></linearGradient>`,
    `<linearGradient id="calm" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${P.calm}" stop-opacity="0"/><stop offset=".28" stop-color="${P.calm}" stop-opacity="0"/><stop offset=".5" stop-color="${P.calm}" stop-opacity=".34"/><stop offset=".72" stop-color="${P.calm}" stop-opacity="0"/><stop offset="1" stop-color="${P.calm}" stop-opacity="0"/></linearGradient>`,
    gradient("gFar", 400, 780, P.far.top, P.far.bottom),
    gradient("gMid", 560, 920, P.mid.top, P.mid.bottom),
    gradient("gNear", 760, 1200, P.near.top, P.near.bottom),
    `<path id="rFar" d="${area(far, H)}"/>`,
    `<path id="rMid" d="${area(mid, H)}"/>`,
    `<path id="rNear" d="${area(near, H)}"/>`,
    `<clipPath id="cFar"><use href="#rFar"/></clipPath>`,
    `<clipPath id="cMid"><use href="#rMid"/></clipPath>`,
    `<clipPath id="cNear"><use href="#rNear"/></clipPath>`,
    `<clipPath id="bFar"><path d="${band(far, 46)}"/></clipPath>`,
    `<clipPath id="bMid"><path d="${band(mid, 40)}"/></clipPath>`,
    `<clipPath id="bNear"><path d="${band(near, 34)}"/></clipPath>`,
    field("fSky", { y0: 12, y1: 700, size: 10, pitch: 13, density: 0.85, seed: 3 }),
    field("fFar", { y0: 430, y1: 800, size: 8, pitch: 10, density: 0.9, seed: 4 }),
    field("fMid", { y0: 570, y1: 940, size: 10, pitch: 12, density: 0.82, seed: 5 }),
    field("fNear", { y0: 750, y1: 1210, size: 13, pitch: 17, density: 0.68, seed: 6 }),
  ].join("");

  const layer = (key: "far" | "mid" | "near", glowOverlay: boolean) => {
    const c = P[key];
    const k = key.charAt(0).toUpperCase() + key.slice(1);
    const [fieldId, grad, clip, rimClip] = [`f${k}`, `g${k}`, `c${k}`, `b${k}`];
    return [
      `<use href="#r${k}" fill="${c.solid}"/>`,
      `<use href="#${fieldId}" fill="url(#${grad})" opacity="${c.alpha}" clip-path="url(#${clip})"/>`,
      glowOverlay
        ? `<use href="#${fieldId}" fill="${P.warm}" opacity=".55" clip-path="url(#${clip})" mask="url(#gm)"/>`
        : "",
      `<use href="#${fieldId}" fill="${c.rim}" opacity="${c.rimAlpha}" clip-path="url(#${rimClip})"/>`,
    ].join("");
  };

  const body = [
    shaft.body,
    pulse(`<rect x="0" y="260" width="${W}" height="800" fill="url(#hglowRect)"/>`, {
      a: 0.8,
      b: 1,
      dur: 38,
    }),
    `<use href="#fSky" fill="${P.skyInk}" opacity="${P.skyInkAlpha}"/>`,
    `<use href="#fSky" fill="${P.warm}" opacity=".16" mask="url(#gm)"/>`,
    specks(rng, { count: 150, fill: P.star, glyphs: ".+*:'", size: 9, opacity: 0.55, y1: 560 }),
    pulse(
      `${curtain(5, 200, 1180, 190, 250, "url(#auG)")}${curtain(9, 760, 1740, 120, 220, "url(#auG)")}<use href="#fSky" fill="${P.auroraA}" opacity=".6" mask="url(#auMask)"/>`,
      { a: 0.78, b: 1, dur: 52 },
    ),
    layer("far", true),
    sway(
      `<rect x="-80" y="560" width="${W + 160}" height="300" fill="url(#mist)" opacity=".16"/>`,
      {
        x: 0,
        y: 0,
        dx: 60,
        dy: 0,
        dur: 90,
      },
    ),
    layer("mid", true),
    layer("near", false),
    `<rect width="${W}" height="${H}" fill="url(#calm)"/>`,
  ].join("");

  const extra = `<radialGradient id="hglowRect" gradientUnits="userSpaceOnUse" cx="560" cy="700" r="780" gradientTransform="translate(560 700) scale(1 .62) translate(-560 -700)"><stop offset="0" stop-color="${P.glow}" stop-opacity="${P.glowAlpha}"/><stop offset=".5" stop-color="${P.glow}" stop-opacity="${fmt(P.glowAlpha * 0.3)}"/><stop offset="1" stop-color="${P.glow}" stop-opacity="0"/></radialGradient>`;

  return wrapPixelSvg({
    canvas: P.canvas,
    defs: `${vGradient("sky", P.sky)}${defs}${extra}`,
    body: `<rect width="${W}" height="${H}" fill="url(#sky)"/>${body}`,
  });
}

const DARK_COLORS = {
  bg0: "#0a0e16",
  bg1: "#0e1420",
  bg2: "#131b2b",
  bg3: "#1a2438",
  bgHover: "#1c2740",
  bgActive: "#243250",
  line: "#1f2a40",
  lineStrong: "#31405e",
  text: "#e4e9f3",
  text2: "#aab6cc",
  text3: "#7b88a2",
  text4: "#566380",
  accent: "#6fe0c0",
  accentInk: "#06130f",
  focus: "#6fe0c0",
};

const LIGHT_COLORS = {
  bg0: "#f2ece0",
  bg1: "#ede5d6",
  bg2: "#e6dccb",
  bg3: "#ddd1be",
  bgHover: "#e0d5c3",
  bgActive: "#d6c9b4",
  line: "#d4c8b4",
  lineStrong: "#bcae96",
  text: "#1d2433",
  text2: "#46506a",
  text3: "#6b7590",
  text4: "#8c93a8",
  accent: "#1f8a72",
  accentInk: "#ffffff",
  focus: "#1f8a72",
};

export function buildGlyphscapeScene(): WallpaperScene {
  return {
    id: "glyphscape",
    name: "Glyphscape",
    tone: "dark",
    canvas: DARK.canvas,
    accent: "#6fe0c0",
    svg: buildGlyphscape("dark"),
    tuning: { dim: 4, panelBlur: 20, surfaceOpacity: 46 },
    colors: DARK_COLORS,
    css: "[data-chat-header]{font-family:var(--font-mono);font-size:12.5px}",
    variant: {
      canvas: LIGHT.canvas,
      accent: "#1f8a72",
      svg: buildGlyphscape("light"),
      tuning: { dim: 6, panelBlur: 22, surfaceOpacity: 78 },
      colors: LIGHT_COLORS,
    },
  };
}
