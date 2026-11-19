export type WallpaperScene = {
  id: string;
  name: string;
  tone: "dark" | "light";
  canvas: string;
  accent: string;
  svg: string;
};

const SVG_WIDTH = 1920;
const SVG_HEIGHT = 1200;
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";
const REDUCED_MOTION_CSS = "@media (prefers-reduced-motion: reduce){*{animation:none!important}}";

/**
 * Deterministic 32-bit PRNG (Mulberry32). Returns floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index] as T;
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

function textCell(x: number, y: number, glyph: string, extraAttrs = ""): string {
  const suffix = extraAttrs ? ` ${extraAttrs}` : "";
  return `<text x="${fmt(x)}" y="${fmt(y)}"${suffix}>${escapeXml(glyph)}</text>`;
}

function wrapSvg(opts: { canvas: string; style: string; defs?: string; body: string }): string {
  const defsBlock = opts.defs ? `<defs>${opts.defs}</defs>` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">`,
    `<style>text{font-family:${FONT_STACK};user-select:none}${opts.style}${REDUCED_MOTION_CSS}</style>`,
    defsBlock,
    `<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="${opts.canvas}" />`,
    `<g font-family="${FONT_STACK}">${opts.body}</g>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join("");
}

function buildRainfallScene(): WallpaperScene {
  const id = "rainfall";
  const name = "Rainfall";
  const canvas = "#0b0e11";
  const accent = "#7aa2f7";
  const rng = mulberry32(0x1a2b3c4d);

  const farGlyphs = [".", ":", ",", "`", "'"] as const;
  const midGlyphs = ["|", ":", ";", ",", ".", "¦"] as const;
  const nearGlyphs = ["|", "│", "¦", ":", "╵"] as const;

  const colStep = 24;
  const rowStep = 24;
  const numCols = SVG_WIDTH / colStep;

  const farCells: string[] = [];
  const midCells: string[] = [];
  const nearDimCells: string[] = [];
  const nearAccentCells: string[] = [];

  for (let col = 0; col < numCols; col += 1) {
    const x = col * colStep + 6;
    const roll = rng();
    if (roll < 0.28) continue;

    const layer = roll < 0.56 ? "far" : roll < 0.84 ? "mid" : "near";
    const streaks = layer === "far" ? 2 : layer === "mid" ? 2 : 1;

    for (let s = 0; s < streaks; s += 1) {
      const len = layer === "far" ? randInt(rng, 4, 7) : randInt(rng, 5, 10);
      const startRow = randInt(rng, 0, 49);

      for (let i = 0; i < len; i += 1) {
        const y = ((startRow + i) % 50) * rowStep + 18;
        const isHead = i === len - 1;
        if (layer === "far") {
          farCells.push(textCell(x, y, pick(rng, farGlyphs)));
        } else if (layer === "mid") {
          midCells.push(textCell(x, y, pick(rng, midGlyphs)));
        } else if (isHead && rng() < 0.55) {
          nearAccentCells.push(textCell(x, y, pick(rng, nearGlyphs)));
        } else {
          nearDimCells.push(textCell(x, y, pick(rng, nearGlyphs)));
        }
      }
    }
  }

  // Faint background rain mist dots
  const mistCells: string[] = [];
  for (let i = 0; i < 90; i += 1) {
    const x = randInt(rng, 0, 79) * colStep + 8;
    const y = randInt(rng, 0, 49) * rowStep + 18;
    mistCells.push(textCell(x, y, rng() < 0.5 ? "." : "·"));
  }

  const style = [
    "@keyframes rf-fall{from{transform:translateY(0)}to{transform:translateY(1200px)}}",
    "@keyframes rf-mist{0%,100%{opacity:0.06}50%{opacity:0.13}}",
    ".rf-far{animation:rf-fall 26s linear infinite}",
    ".rf-mid{animation:rf-fall 17s linear infinite;animation-delay:-6.5s}",
    ".rf-near{animation:rf-fall 11s linear infinite;animation-delay:-3.2s}",
    ".rf-mist{animation:rf-mist 9s ease-in-out infinite}",
  ].join("");

  const defs = [
    `<g id="rf-far-tile" fill="#8b9bb4" font-size="14" opacity="0.14">${farCells.join("")}</g>`,
    `<g id="rf-mid-tile" fill="#9fb2cc" font-size="15" opacity="0.22">${midCells.join("")}</g>`,
    `<g id="rf-near-tile" font-size="16"><g fill="#b4c6e0" opacity="0.28">${nearDimCells.join("")}</g><g fill="${accent}" opacity="0.5">${nearAccentCells.join("")}</g></g>`,
  ].join("");

  const body = [
    `<g class="rf-mist" fill="#8b9bb4" font-size="13">${mistCells.join("")}</g>`,
    `<g class="rf-far"><use href="#rf-far-tile" y="0" /><use href="#rf-far-tile" y="-1200" /></g>`,
    `<g class="rf-mid"><use href="#rf-mid-tile" y="0" /><use href="#rf-mid-tile" y="-1200" /></g>`,
    `<g class="rf-near"><use href="#rf-near-tile" y="0" /><use href="#rf-near-tile" y="-1200" /></g>`,
  ].join("");

  return {
    id,
    name,
    tone: "dark",
    canvas,
    accent,
    svg: wrapSvg({ canvas, style, defs, body }),
  };
}

function buildTideScene(): WallpaperScene {
  const id = "tide";
  const name = "Tide";
  const canvas = "#071316";
  const accent = "#5eead4";
  const rng = mulberry32(0x2b4c6d8e);

  const horizonStars: string[] = [];
  for (let i = 0; i < 42; i += 1) {
    const x = randInt(rng, 16, SVG_WIDTH - 16);
    const y = randInt(rng, 28, 250);
    horizonStars.push(textCell(x, y, rng() < 0.7 ? "." : "·"));
  }

  const waveRows = 16;
  const colStep = 24;
  const cols = SVG_WIDTH / colStep;
  const waveDefs: string[] = [];
  const waveUses: string[] = [];
  const styleParts: string[] = [
    "@keyframes td-right{from{transform:translateX(0)}to{transform:translateX(1920px)}}",
    "@keyframes td-left{from{transform:translateX(0)}to{transform:translateX(-1920px)}}",
    "@keyframes td-bob{0%,100%{transform:translateY(-5px)}50%{transform:translateY(5px)}}",
    "@keyframes td-glint{0%,100%{opacity:0.12}50%{opacity:0.46}}",
    ".td-sky{opacity:0.12}",
  ];

  const baseGlyphs = ["~", "≈", "∼", "-", "_", "."] as const;

  for (let r = 0; r < waveRows; r += 1) {
    const depth = r / (waveRows - 1);
    const baseY = 290 + r * 56;
    const amp = 8 + depth * 12;
    const freq = (Math.PI * 2 * (2 + (r % 3))) / SVG_WIDTH;
    const phase = rng() * Math.PI * 2;

    const dimCells: string[] = [];
    const accentCells: string[] = [];

    for (let c = 0; c < cols; c += 1) {
      const x = c * colStep + 4;
      const waveOffset = Math.sin(x * freq + phase) * amp;
      const y = baseY + waveOffset;
      const slope = Math.cos(x * freq + phase);

      let glyph: string;
      if (slope > 0.55) glyph = "~";
      else if (slope < -0.55) glyph = "∼";
      else if (waveOffset < -amp * 0.55) glyph = rng() < 0.35 ? "^" : "≈";
      else glyph = pick(rng, baseGlyphs);

      const isCrest = waveOffset < -amp * 0.5 && rng() < 0.22 && depth > 0.25;
      if (isCrest) {
        accentCells.push(textCell(x, y, rng() < 0.5 ? "≈" : "~"));
      } else {
        dimCells.push(textCell(x, y, glyph));
      }
    }

    const rowOpacity = fmt(0.11 + depth * 0.19);
    const fontSize = Math.round(14 + depth * 4);
    const fill = depth < 0.4 ? "#5a8f96" : "#6db8ba";
    const tileId = `td-row-${r}`;

    waveDefs.push(
      `<g id="${tileId}" font-size="${fontSize}"><g fill="${fill}" opacity="${rowOpacity}">${dimCells.join("")}</g>${accentCells.length ? `<g fill="${accent}" class="td-glint">${accentCells.join("")}</g>` : ""}</g>`,
    );

    const driftRight = r % 2 === 0;
    const driftDur = Math.round(28 - depth * 12);
    const bobDur = fmt(6.5 + (r % 4) * 1.4);
    const delay = fmt(-rng() * driftDur);
    const driftCls = `td-d-${r}`;
    const bobCls = `td-b-${r}`;

    styleParts.push(
      `.${driftCls}{animation:${driftRight ? "td-right" : "td-left"} ${driftDur}s linear infinite;animation-delay:${delay}s}`,
      `.${bobCls}{animation:td-bob ${bobDur}s ease-in-out infinite;animation-delay:${fmt(-rng() * 6)}s}`,
    );

    const copyOffset = driftRight ? -SVG_WIDTH : SVG_WIDTH;
    waveUses.push(
      `<g class="${bobCls}"><g class="${driftCls}"><use href="#${tileId}" x="0" /><use href="#${tileId}" x="${copyOffset}" /></g></g>`,
    );
  }

  styleParts.push(".td-glint{animation:td-glint 7s ease-in-out infinite}");

  return {
    id,
    name,
    tone: "dark",
    canvas,
    accent,
    svg: wrapSvg({
      canvas,
      style: styleParts.join(""),
      defs: waveDefs.join(""),
      body: `<g class="td-sky" fill="#7aa6ab" font-size="13">${horizonStars.join("")}</g>${waveUses.join("")}`,
    }),
  };
}

function buildStarfieldScene(): WallpaperScene {
  const id = "starfield";
  const name = "Starfield";
  const canvas = "#090a10";
  const accent = "#d7c9a7";
  const rng = mulberry32(0x3c5e7a91);

  const dimGlyphs = [".", "·", ":", ".", "·"] as const;
  const midGlyphs = ["+", "*", "·", "×", "°"] as const;
  const accentGlyphs = ["*", "+", "✦"] as const;

  const twinkleBuckets: string[][] = Array.from({ length: 6 }, () => []);
  const accentBuckets: string[][] = Array.from({ length: 3 }, () => []);
  const dustCells: string[] = [];

  // Diagonal nebula dust band
  for (let i = 0; i < 140; i += 1) {
    const t = rng();
    const cx = t * SVG_WIDTH;
    const cy = 980 - t * 720 + (rng() - 0.5) * 280;
    if (cy < 20 || cy > SVG_HEIGHT - 20) continue;
    dustCells.push(textCell(cx, cy, rng() < 0.65 ? "." : "·"));
  }

  // Procedural star field
  for (let i = 0; i < 290; i += 1) {
    const x = randInt(rng, 20, SVG_WIDTH - 20);
    const y = randInt(rng, 24, SVG_HEIGHT - 20);
    const roll = rng();
    if (roll < 0.05) {
      const bucket = i % accentBuckets.length;
      accentBuckets[bucket]?.push(textCell(x, y, pick(rng, accentGlyphs)));
    } else if (roll < 0.34) {
      const bucket = i % twinkleBuckets.length;
      twinkleBuckets[bucket]?.push(textCell(x, y, pick(rng, midGlyphs)));
    } else {
      const bucket = i % twinkleBuckets.length;
      twinkleBuckets[bucket]?.push(textCell(x, y, pick(rng, dimGlyphs)));
    }
  }

  const periods = [5, 7, 9, 11, 13, 17] as const;
  const styleParts: string[] = [
    "@keyframes sf-tw-dim{0%,100%{opacity:0.08}50%{opacity:0.28}}",
    "@keyframes sf-tw-bright{0%,100%{opacity:0.18}50%{opacity:0.55}}",
    "@keyframes sf-dust{0%,100%{opacity:0.06}50%{opacity:0.12}}",
    "@keyframes sf-comet{0%{transform:translate(-260px,-100px);opacity:0}6%{opacity:0.55}34%{opacity:0.48}40%,100%{transform:translate(2160px,920px);opacity:0}}",
    ".sf-dust{animation:sf-dust 19s ease-in-out infinite}",
    ".sf-comet{animation:sf-comet 26s linear infinite;animation-delay:-4s}",
  ];

  const groups: string[] = [
    `<g class="sf-dust" fill="#8f98b8" font-size="12">${dustCells.join("")}</g>`,
  ];

  twinkleBuckets.forEach((cells, idx) => {
    const cls = `sf-t-${idx}`;
    const dur = periods[idx] ?? 9;
    const delay = fmt(-rng() * dur);
    styleParts.push(
      `.${cls}{animation:sf-tw-dim ${dur}s ease-in-out infinite;animation-delay:${delay}s}`,
    );
    groups.push(
      `<g class="${cls}" fill="#b7c0d8" font-size="${idx % 2 === 0 ? 14 : 15}">${cells.join("")}</g>`,
    );
  });

  accentBuckets.forEach((cells, idx) => {
    const cls = `sf-a-${idx}`;
    const dur = 8 + idx * 3;
    const delay = fmt(-rng() * dur);
    styleParts.push(
      `.${cls}{animation:sf-tw-bright ${dur}s ease-in-out infinite;animation-delay:${delay}s}`,
    );
    groups.push(`<g class="${cls}" fill="${accent}" font-size="16">${cells.join("")}</g>`);
  });

  const comet = [
    `<g class="sf-comet" font-size="16">`,
    `<g fill="#b7c0d8" opacity="0.32">${textCell(-18, -7, ".")}${textCell(-36, -15, "-")}${textCell(-54, -22, "~")}${textCell(-74, -30, ".")}${textCell(-96, -39, "·")}</g>`,
    `<g fill="${accent}">${textCell(0, 0, "*")}</g>`,
    `</g>`,
  ].join("");

  return {
    id,
    name,
    tone: "dark",
    canvas,
    accent,
    svg: wrapSvg({
      canvas,
      style: styleParts.join(""),
      body: `${groups.join("")}${comet}`,
    }),
  };
}

function buildEmberScene(): WallpaperScene {
  const id = "ember";
  const name = "Ember";
  const canvas = "#140a09";
  const accent = "#f08a4b";
  const rng = mulberry32(0x4d6f8b03);

  const floorGlyphs = ["#", "%", "=", "~", ":", ".", ";", "^"] as const;
  const sparkGlyphs = ["*", "+", "°", "'", ",", ".", "^"] as const;

  // Dark-red glowing coal bed across bottom rows
  const floorBuckets: string[][] = [[], [], []];
  const floorHotCells: string[] = [];
  for (let row = 0; row < 10; row += 1) {
    const y = 970 + row * 24;
    const density = 0.25 + (row / 9) * 0.55;
    for (let col = 0; col < 80; col += 1) {
      if (rng() > density) continue;
      const x = col * 24 + 6;
      const g = pick(rng, floorGlyphs);
      if (row >= 5 && rng() < 0.08) {
        floorHotCells.push(textCell(x, y, g));
      } else {
        floorBuckets[(row + col) % 3]?.push(textCell(x, y, g));
      }
    }
  }

  // Rising sparks across 3 thermal speeds
  const slowSparks: string[] = [];
  const midSparks: string[] = [];
  const hotSparks: string[] = [];

  for (let i = 0; i < 115; i += 1) {
    const x = randInt(rng, 24, SVG_WIDTH - 24);
    const y = randInt(rng, 24, SVG_HEIGHT - 24);
    const g = pick(rng, sparkGlyphs);
    const roll = rng();
    if (roll < 0.16) {
      hotSparks.push(textCell(x, y, g));
    } else if (roll < 0.55) {
      midSparks.push(textCell(x, y, g));
    } else {
      slowSparks.push(textCell(x, y, g));
    }
  }

  const style = [
    "@keyframes em-rise{from{transform:translateY(0)}to{transform:translateY(-1200px)}}",
    "@keyframes em-sway{0%,100%{transform:translateX(-8px)}50%{transform:translateX(8px)}}",
    "@keyframes em-coal-a{0%,100%{opacity:0.1}50%{opacity:0.24}}",
    "@keyframes em-coal-b{0%,100%{opacity:0.14}50%{opacity:0.29}}",
    "@keyframes em-coal-hot{0%,100%{opacity:0.26}50%{opacity:0.52}}",
    ".em-floor-0{animation:em-coal-a 6.5s ease-in-out infinite}",
    ".em-floor-1{animation:em-coal-b 8.5s ease-in-out infinite;animation-delay:-2.5s}",
    ".em-floor-2{animation:em-coal-a 11s ease-in-out infinite;animation-delay:-5s}",
    ".em-floor-hot{animation:em-coal-hot 7s ease-in-out infinite;animation-delay:-1.5s}",
    ".em-rise-slow{animation:em-rise 25s linear infinite}",
    ".em-rise-mid{animation:em-rise 18s linear infinite;animation-delay:-7s}",
    ".em-rise-fast{animation:em-rise 13s linear infinite;animation-delay:-4s}",
    ".em-sway-a{animation:em-sway 6s ease-in-out infinite}",
    ".em-sway-b{animation:em-sway 8s ease-in-out infinite;animation-delay:-3s}",
  ].join("");

  const defs = [
    `<g id="em-slow-tile" fill="#b84a39" font-size="14" opacity="0.2">${slowSparks.join("")}</g>`,
    `<g id="em-mid-tile" fill="#d46a43" font-size="15" opacity="0.28">${midSparks.join("")}</g>`,
    `<g id="em-hot-tile" fill="${accent}" font-size="16" opacity="0.5">${hotSparks.join("")}</g>`,
  ].join("");

  const body = [
    `<g font-size="16">`,
    `<g class="em-floor-0" fill="#8c2d23">${floorBuckets[0]?.join("") ?? ""}</g>`,
    `<g class="em-floor-1" fill="#a83b2c">${floorBuckets[1]?.join("") ?? ""}</g>`,
    `<g class="em-floor-2" fill="#7a241c">${floorBuckets[2]?.join("") ?? ""}</g>`,
    `<g class="em-floor-hot" fill="${accent}">${floorHotCells.join("")}</g>`,
    `</g>`,
    `<g class="em-sway-a"><g class="em-rise-slow"><use href="#em-slow-tile" y="0" /><use href="#em-slow-tile" y="1200" /></g></g>`,
    `<g class="em-sway-b"><g class="em-rise-mid"><use href="#em-mid-tile" y="0" /><use href="#em-mid-tile" y="1200" /></g></g>`,
    `<g class="em-sway-a"><g class="em-rise-fast"><use href="#em-hot-tile" y="0" /><use href="#em-hot-tile" y="1200" /></g></g>`,
  ].join("");

  return {
    id,
    name,
    tone: "dark",
    canvas,
    accent,
    svg: wrapSvg({ canvas, style, defs, body }),
  };
}

function buildPaperSkyScene(): WallpaperScene {
  const id = "paper-sky";
  const name = "Paper sky";
  const canvas = "#f4f1ea";
  const accent = "#4a6fa5";
  const rng = mulberry32(0x5e7193b5);

  const cellW = 18;
  const cellH = 22;

  function makeCloud(cx: number, cy: number, widthCells: number, rows: number): string[] {
    const out: string[] = [];
    for (let r = 0; r < rows; r += 1) {
      const normY = (r - (rows - 1) / 2) / Math.max(1, rows / 2);
      const span = Math.max(
        3,
        Math.round(widthCells * Math.sqrt(Math.max(0.15, 1 - normY * normY * 0.72))),
      );
      const startCol = -Math.floor(span / 2);
      for (let c = 0; c < span; c += 1) {
        const x = cx + (startCol + c) * cellW;
        const y = cy + r * cellH;
        const isEdge = c === 0 || c === span - 1;
        let glyph: string;
        if (r === 0) glyph = isEdge ? "." : "_";
        else if (r === rows - 1) glyph = isEdge ? "," : "-";
        else if (isEdge) glyph = c === 0 ? "(" : ")";
        else glyph = rng() < 0.6 ? "~" : "-";
        out.push(textCell(x, y, glyph));
      }
    }
    return out;
  }

  const backClouds: string[] = [];
  const midClouds: string[] = [];
  const frontClouds: string[] = [];

  for (let i = 0; i < 5; i += 1) {
    const cx = 180 + i * 380 + randInt(rng, -50, 50);
    const cy = randInt(rng, 140, 880);
    backClouds.push(...makeCloud(cx, cy, randInt(rng, 14, 22), randInt(rng, 3, 5)));
  }

  for (let i = 0; i < 4; i += 1) {
    const cx = 240 + i * 460 + randInt(rng, -60, 60);
    const cy = randInt(rng, 180, 920);
    midClouds.push(...makeCloud(cx, cy, randInt(rng, 16, 24), randInt(rng, 4, 5)));
  }

  for (let i = 0; i < 3; i += 1) {
    const cx = 320 + i * 600 + randInt(rng, -70, 70);
    const cy = randInt(rng, 220, 860);
    frontClouds.push(...makeCloud(cx, cy, randInt(rng, 18, 26), randInt(rng, 4, 6)));
  }

  // Distant ink birds + gentle paper grain
  const birds: string[] = [
    textCell(520, 290, "~"),
    textCell(538, 286, "v"),
    textCell(556, 290, "~"),
    textCell(1340, 410, "~"),
    textCell(1358, 406, "v"),
    textCell(1376, 410, "~"),
  ];
  const grain: string[] = [];
  for (let i = 0; i < 70; i += 1) {
    grain.push(textCell(randInt(rng, 20, SVG_WIDTH - 20), randInt(rng, 20, SVG_HEIGHT - 20), "."));
  }

  const style = [
    "@keyframes ps-drift{from{transform:translateX(0)}to{transform:translateX(1920px)}}",
    "@keyframes ps-float{0%,100%{transform:translateY(-4px)}50%{transform:translateY(4px)}}",
    ".ps-back{animation:ps-drift 29s linear infinite}",
    ".ps-mid{animation:ps-drift 22s linear infinite;animation-delay:-8s}",
    ".ps-front{animation:ps-drift 16s linear infinite;animation-delay:-4s}",
    ".ps-birds{animation:ps-float 7s ease-in-out infinite}",
  ].join("");

  const defs = [
    `<g id="ps-back-tile" fill="#7c8794" font-size="15" opacity="0.14">${backClouds.join("")}</g>`,
    `<g id="ps-mid-tile" fill="#64707d" font-size="16" opacity="0.2">${midClouds.join("")}</g>`,
    `<g id="ps-front-tile" fill="#525d69" font-size="16" opacity="0.25">${frontClouds.join("")}</g>`,
  ].join("");

  const body = [
    `<g fill="#8b949e" font-size="12" opacity="0.12">${grain.join("")}</g>`,
    `<g class="ps-back"><use href="#ps-back-tile" x="0" /><use href="#ps-back-tile" x="-1920" /></g>`,
    `<g class="ps-mid"><use href="#ps-mid-tile" x="0" /><use href="#ps-mid-tile" x="-1920" /></g>`,
    `<g class="ps-front"><use href="#ps-front-tile" x="0" /><use href="#ps-front-tile" x="-1920" /></g>`,
    `<g class="ps-birds" fill="${accent}" font-size="16" opacity="0.44">${birds.join("")}</g>`,
  ].join("");

  return {
    id,
    name,
    tone: "light",
    canvas,
    accent,
    svg: wrapSvg({ canvas, style, defs, body }),
  };
}

function buildCircuitScene(): WallpaperScene {
  const id = "circuit";
  const name = "Circuit";
  const canvas = "#0a0f0d";
  const accent = "#52d1a2";
  const rng = mulberry32(0x6f82a4c7);

  const cellW = 24;
  const cellH = 24;
  const cols = SVG_WIDTH / cellW;
  const rows = SVG_HEIGHT / cellH;

  const traceCells: string[] = [];
  const nodeBuckets: string[][] = [[], [], [], []];
  const accentNodes: string[] = [];

  type PulseTrack = {
    axis: "x" | "y";
    x: number;
    y: number;
    span: number;
    dur: number;
    delay: number;
    glyph: string;
  };
  const tracks: PulseTrack[] = [];

  // Procedural horizontal & L-bend PCB buses
  const busRows = [5, 11, 17, 23, 29, 35, 41, 46];
  busRows.forEach((r, busIdx) => {
    const startCol = randInt(rng, 1, 10);
    const endCol = randInt(rng, cols - 12, cols - 2);
    const turnCol = randInt(rng, startCol + 8, endCol - 8);
    const turnDir = busIdx % 2 === 0 ? 1 : -1;
    const jogRows = randInt(rng, 2, 3);

    let curR = r;
    for (let c = startCol; c <= endCol; c += 1) {
      const x = c * cellW + 4;
      const y = curR * cellH + 18;

      if (c === startCol || c === endCol) {
        const pad = rng() < 0.35 ? "▪" : "o";
        if (rng() < 0.25) accentNodes.push(textCell(x, y, pad));
        else nodeBuckets[(c + r) % 4]?.push(textCell(x, y, pad));
      } else if (c === turnCol) {
        traceCells.push(textCell(x, y, turnDir > 0 ? "┐" : "┘"));
        for (let j = 1; j < jogRows; j += 1) {
          curR += turnDir;
          traceCells.push(textCell(x, curR * cellH + 18, "│"));
        }
        curR += turnDir;
        traceCells.push(textCell(x, curR * cellH + 18, turnDir > 0 ? "└" : "┌"));
      } else if (c % 11 === 0 && rng() < 0.65) {
        traceCells.push(textCell(x, y, "┴"));
        traceCells.push(textCell(x, y - cellH, "│"));
        nodeBuckets[(c + r) % 4]?.push(textCell(x, y - cellH * 2, "o"));
      } else {
        traceCells.push(textCell(x, y, "─"));
      }
    }

    // Add a traveling signal pulse on the main straight section before the jog
    const pulseSpan = Math.max(140, (turnCol - startCol - 2) * cellW);
    tracks.push({
      axis: "x",
      x: (startCol + 1) * cellW + 4,
      y: r * cellH + 18,
      span: pulseSpan,
      dur: randInt(rng, 5, 11),
      delay: -Number((rng() * 8).toFixed(1)),
      glyph: rng() < 0.5 ? "▪" : "═",
    });
  });

  // Orthogonal vertical buses
  const busCols = [10, 22, 36, 52, 66];
  for (const c of busCols) {
    const startRow = randInt(rng, 2, 8);
    const endRow = randInt(rng, rows - 9, rows - 2);
    const x = c * cellW + 4;
    for (let r = startRow; r <= endRow; r += 1) {
      const y = r * cellH + 18;
      if (r === startRow || r === endRow) {
        accentNodes.push(textCell(x, y, "o"));
      } else if (r % 9 === 0) {
        nodeBuckets[(c + r) % 4]?.push(textCell(x, y, "+"));
      } else {
        traceCells.push(textCell(x, y, "│"));
      }
    }
    tracks.push({
      axis: "y",
      x,
      y: (startRow + 1) * cellH + 18,
      span: Math.max(160, (endRow - startRow - 2) * cellH),
      dur: randInt(rng, 6, 13),
      delay: -Number((rng() * 9).toFixed(1)),
      glyph: "▪",
    });
  }

  // Background grid reference dots
  const gridDots: string[] = [];
  for (let r = 2; r < rows; r += 4) {
    for (let c = 2; c < cols; c += 4) {
      gridDots.push(textCell(c * cellW + 4, r * cellH + 18, "·"));
    }
  }

  const styleParts: string[] = [
    "@keyframes cc-node{0%,100%{opacity:0.14}50%{opacity:0.34}}",
    "@keyframes cc-accent{0%,100%{opacity:0.25}50%{opacity:0.58}}",
  ];

  tracks.forEach((tr, idx) => {
    const kf = `cc-p-${idx}`;
    const cls = `cc-pulse-${idx}`;
    const endTx = tr.axis === "x" ? `translateX(${tr.span}px)` : `translateY(${tr.span}px)`;
    const startTx = tr.axis === "x" ? "translateX(0)" : "translateY(0)";
    styleParts.push(
      `@keyframes ${kf}{0%{transform:${startTx};opacity:0}12%{opacity:0.55}72%{opacity:0.48}88%,100%{transform:${endTx};opacity:0}}`,
      `.${cls}{animation:${kf} ${tr.dur}s linear infinite;animation-delay:${tr.delay}s}`,
    );
  });

  [5, 7, 9, 11].forEach((dur, idx) => {
    styleParts.push(
      `.cc-n-${idx}{animation:cc-node ${dur}s ease-in-out infinite;animation-delay:${fmt(-idx * 1.4)}s}`,
    );
  });
  styleParts.push(".cc-acc{animation:cc-accent 6.5s ease-in-out infinite}");

  const body = [
    `<g fill="#2b5244" font-size="13" opacity="0.12">${gridDots.join("")}</g>`,
    `<g fill="#3b6e5c" font-size="15" opacity="0.16">${traceCells.join("")}</g>`,
    nodeBuckets
      .map(
        (cells, idx) =>
          `<g class="cc-n-${idx}" fill="#4ea383" font-size="15">${cells.join("")}</g>`,
      )
      .join(""),
    `<g class="cc-acc" fill="${accent}" font-size="15">${accentNodes.join("")}</g>`,
    `<g fill="${accent}" font-size="15">${tracks
      .map((tr, idx) => `<g class="cc-pulse-${idx}">${textCell(tr.x, tr.y, tr.glyph)}</g>`)
      .join("")}</g>`,
  ].join("");

  return {
    id,
    name,
    tone: "dark",
    canvas,
    accent,
    svg: wrapSvg({ canvas, style: styleParts.join(""), body }),
  };
}

export function buildWallpaperScenes(): WallpaperScene[] {
  return [
    buildRainfallScene(),
    buildTideScene(),
    buildStarfieldScene(),
    buildEmberScene(),
    buildPaperSkyScene(),
    buildCircuitScene(),
  ];
}

export const WALLPAPER_SCENES: WallpaperScene[] = buildWallpaperScenes();

const SCRIPT_TAG_RE = /<\s*\/?\s*(?:[a-z0-9_-]+:)?script\b/i;
const FOREIGN_OBJECT_RE = /<\s*\/?\s*(?:[a-z0-9_-]+:)?foreignObject\b/i;
const EVENT_HANDLER_RE = /(?:^|[\s/])on[a-z][a-z0-9_-]*\s*=/i;
const HREF_ATTR_RE = /\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*))/gi;
const LOCAL_FRAGMENT_RE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const CSS_IMPORT_RE = /@import/i;
const CSS_URL_START_RE = /\burl\s*\(/gi;
const CSS_URL_LOCAL_FRAGMENT_RE =
  /^\s*(?:#[A-Za-z_][A-Za-z0-9_.:-]*|"#[A-Za-z_][A-Za-z0-9_.:-]*"|'#[A-Za-z_][A-Za-z0-9_.:-]*')\s*\)/;

export function assertSafeSvg(svg: string): void {
  if (SCRIPT_TAG_RE.test(svg)) {
    throw new Error("Unsafe SVG: <script> tags are not allowed.");
  }
  if (FOREIGN_OBJECT_RE.test(svg)) {
    throw new Error("Unsafe SVG: <foreignObject> tags are not allowed.");
  }
  if (EVENT_HANDLER_RE.test(svg)) {
    throw new Error("Unsafe SVG: event-handler attributes (on*) are not allowed.");
  }
  if (CSS_IMPORT_RE.test(svg)) {
    throw new Error("Unsafe SVG: @import rules are not allowed.");
  }

  for (const match of svg.matchAll(HREF_ATTR_RE)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!LOCAL_FRAGMENT_RE.test(target)) {
      throw new Error(`Unsafe SVG: external or invalid href "${target}".`);
    }
  }

  for (const match of svg.matchAll(CSS_URL_START_RE)) {
    const afterOpenParen = svg.slice(match.index + match[0].length);
    if (!CSS_URL_LOCAL_FRAGMENT_RE.test(afterOpenParen)) {
      throw new Error("Unsafe SVG: url() may only reference local #id fragments.");
    }
  }
}

export function toDataUrl(svg: string): string {
  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}
