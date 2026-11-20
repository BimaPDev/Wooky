import {
  H,
  PixelKit,
  W,
  cross,
  glow,
  pulse,
  shafts,
  specks,
  sway,
  vGradient,
  wrapPixelSvg,
  type Shaft,
} from "./pixel-kit.ts";
import {
  BIRD,
  BUBBLE,
  CORAL,
  FISH_BLUE,
  FISH_BROWN,
  FISH_ORANGE,
  FISH_RED,
  FISH_YELLOW,
  LOTUS,
  cloudSprite,
  hillSprite,
  jellySprite,
  koiSprite,
  mantaSprite,
  moonSprite,
  padSprite,
  ringSprite,
  seaweedSprite,
  stoneSprite,
  sunSprite,
  turtleSprite,
} from "./pixel-sprites.ts";
import { buildGlyphscapeScene } from "./glyphscape.ts";
import { escapeXml, mulberry32, type WallpaperScene } from "./scenes.ts";

type Stops = ReadonlyArray<readonly [number, string]>;

function build(o: {
  kit: PixelKit;
  canvas: string;
  sky: Stops;
  extraDefs?: string;
  body: string;
}): string {
  return wrapPixelSvg({
    canvas: o.canvas,
    defs: `${vGradient("sky", o.sky)}${o.kit.defs.join("")}${o.extraDefs ?? ""}`,
    body: `<rect width="${W}" height="${H}" fill="url(#sky)"/>${o.body}`,
  });
}

function shaftLayer(colour: string, list: readonly Shaft[]): { defs: string; body: string } {
  return shafts("shaft", colour, list);
}

function dusk(): WallpaperScene {
  const kit = new PixelKit(14, 0x1d05);
  const rng = mulberry32(0xd05c);
  const sun = sunSprite(5, {
    a: "#fbc690",
    b: "#e58a50",
    c: "#b0502e",
    r: "#8c3e27",
    q: "#6d2f1f",
  });
  const sunSize = kit.sprite("sun", sun);
  const farHill = hillSprite(
    138,
    13,
    (x) => 7 + Math.sin(x * 0.045) * 3 + Math.sin(x * 0.13 + 1) * 1.6,
    { top: "#3a2218", body: "#2c1a13", deep: "#22140f" },
  );
  kit.sprite("hill-far", farHill);
  const nearHill = hillSprite(
    138,
    9,
    (x) => 4 + Math.sin(x * 0.07 + 2) * 2.4 + Math.sin(x * 0.19) * 1,
    { top: "#2d1b13", body: "#22150f", deep: "#1b100c" },
  );
  kit.sprite("hill-near", nearHill);
  const sx = 1460;
  const sy = 90;
  const cx = sx + sunSize.w / 2;
  const cy = sy + sunSize.h / 2;
  const shaft = shaftLayer("#f0a070", [
    { x: 300, w: 320, op: 0.035 },
    { x: 960, w: 240, op: 0.025 },
    { x: 1420, w: 380, op: 0.05 },
  ]);
  const avoid = { x0: 700, x1: 1220 };
  const body = [
    shaft.body,
    pulse(`<circle cx="${cx}" cy="${cy}" r="640" fill="url(#sunglow)"/>`, {
      a: 0.7,
      b: 1,
      dur: 36,
    }),
    kit.place("sun", sx, sy),
    kit.place("hill-far", 0, H - 13 * 14, { opacity: 0.9 }),
    kit.place("hill-near", 0, H - 9 * 14, { opacity: 0.9 }),
    sway(
      specks(rng, { count: 80, fill: "#e8a070", glyphs: ".:'`,", size: 10, opacity: 0.5, avoid }),
      {
        x: 0,
        y: 0,
        dx: 26,
        dy: -38,
        dur: 52,
      },
    ),
    sway(specks(rng, { count: 50, fill: "#c9805a", glyphs: ".:", size: 8, opacity: 0.4, avoid }), {
      x: 0,
      y: 0,
      dx: -18,
      dy: -26,
      dur: 70,
    }),
  ].join("");
  return {
    id: "dusk",
    name: "Dusk sun",
    tone: "dark",
    canvas: "#17100e",
    accent: "#ee8a4c",
    tuning: { dim: 8, panelBlur: 6, surfaceOpacity: 50 },
    svg: build({
      kit,
      canvas: "#17100e",
      sky: [
        [0, "#110b0a"],
        [0.55, "#1d1210"],
        [1, "#3b2017"],
      ],
      extraDefs: `${glow("sunglow", "#f08a4c", 0.3)}${shaft.defs}`,
      body,
    }),
  };
}

function daydream(): WallpaperScene {
  const kit = new PixelKit(14, 0xda7);
  const rng = mulberry32(0xda7d);
  const pal = { w: "#ffffff", s: "#e3f1fc", b: "#c8e0f3" };
  const defs: Array<[string, number, number, number]> = [
    ["cA", 24, 9, 11],
    ["cB", 30, 10, 12],
    ["cC", 20, 8, 13],
    ["cD", 34, 10, 14],
    ["cE", 22, 8, 15],
    ["cF", 14, 6, 16],
  ];
  const sizes = new Map<string, { w: number; h: number }>();
  for (const [name, w, h, seed] of defs)
    sizes.set(name, kit.sprite(name, cloudSprite(w, h, seed, pal)));
  kit.sprite("bird", BIRD);
  const drift = (name: string, x: number, y: number, dur: number, flip = false) => {
    const size = sizes.get(name);
    if (!size) throw new Error(name);
    return cross(kit.place(name, 0, 0, { flip }), { x, y, from: -size.w - 40, to: W + 40, dur });
  };
  const shaft = shaftLayer("#ffffff", [
    { x: 330, w: 320, op: 0.3 },
    { x: 1020, w: 220, op: 0.22 },
    { x: 1450, w: 400, op: 0.28 },
  ]);
  const body = [
    shaft.body,
    specks(rng, { count: 70, fill: "#ffffff", glyphs: ".:'", size: 9, opacity: 0.7 }),
    specks(rng, { count: 40, fill: "#5d9fd2", glyphs: ".:,", size: 8, opacity: 0.35 }),
    drift("cA", 100, 150, 110),
    drift("cB", 1330, 70, 96),
    drift("cC", 1560, 470, 120),
    drift("cD", 1380, 880, 104),
    drift("cE", 50, 830, 88),
    kit.place("cF", 830, 40, { opacity: 0.9 }),
    sway(
      `${kit.place("bird", 0, 0, { scale: 0.55 })}${kit.place("bird", 70, 36, { scale: 0.45 })}`,
      {
        x: 560,
        y: 360,
        dx: 90,
        dy: -26,
        dur: 64,
      },
    ),
  ].join("");
  return {
    id: "daydream",
    name: "Daydream",
    tone: "light",
    canvas: "#cfe6f7",
    accent: "#2c78c6",
    tuning: { dim: 6, panelBlur: 5, surfaceOpacity: 66 },
    svg: build({
      kit,
      canvas: "#cfe6f7",
      sky: [
        [0, "#58b0f0"],
        [0.5, "#9fd0f4"],
        [1, "#d8edfa"],
      ],
      extraDefs: shaft.defs,
      body,
    }),
  };
}

function reef(): WallpaperScene {
  const kit = new PixelKit(14, 0x4ee5);
  const rng = mulberry32(0x4ee7);
  const turtle = turtleSprite({
    g: "#b79b45",
    G: "#ddc56a",
    d: "#6e5825",
    s: "#88a44e",
    S: "#5f7a36",
  });
  const tSize = kit.sprite("turtle", turtle);
  const mSize = kit.sprite("manta", mantaSprite({ b: "#1c5368", B: "#2a7188", d: "#123c4c" }));
  kit.sprite("f-orange", FISH_ORANGE);
  kit.sprite("f-blue", FISH_BLUE);
  kit.sprite("f-yellow", FISH_YELLOW);
  kit.sprite("f-red", FISH_RED);
  kit.sprite("bubble", BUBBLE);
  kit.sprite("coral", CORAL);
  kit.sprite("weed-a", seaweedSprite(18, 3, { a: "#2f9a5c", b: "#1f7a48" }));
  kit.sprite("weed-b", seaweedSprite(13, 8, { a: "#3aa866", b: "#25804c" }));
  kit.sprite(
    "sand",
    hillSprite(138, 5, (x) => 2.4 + Math.sin(x * 0.11) * 1.3 + Math.sin(x * 0.4) * 0.5, {
      top: "#17707a",
      body: "#0f5a66",
      deep: "#0a4652",
    }),
  );
  const bubbles: string[] = [];
  for (const [x0, count, seed] of [
    [300, 12, 1],
    [1500, 10, 2],
    [1780, 9, 3],
  ] as const) {
    const r = mulberry32(seed);
    for (let i = 0; i < count; i += 1) {
      const x = x0 + (r() - 0.5) * 70;
      const y = (i / count) * H + r() * 90;
      const s = 0.35 + r() * 0.5;
      bubbles.push(kit.place("bubble", x, y, { scale: s, opacity: 0.85 }));
      bubbles.push(kit.place("bubble", x, y + H, { scale: s, opacity: 0.85 }));
    }
  }
  const shaft = shaftLayer("#b8fff6", [
    { x: 300, w: 320, op: 0.12 },
    { x: 1030, w: 220, op: 0.08 },
    { x: 1440, w: 380, op: 0.1 },
  ]);
  const swim = (name: string, x: number, y: number, dur: number, left = false, scale = 0.85) => {
    const size = kit.size(name);
    const w = size.w * scale;
    return cross(kit.place(name, 0, 0, { flip: left, scale }), {
      x,
      y,
      from: left ? W + 60 : -w - 60,
      to: left ? -w - 60 : W + 60,
      dur,
    });
  };
  const body = [
    `<rect width="${W}" height="${H}" fill="url(#light)"/>`,
    shaft.body,
    specks(rng, { count: 90, fill: "#c8fff8", glyphs: ".:,'", size: 9, opacity: 0.45 }),
    kit.place("sand", 0, H - 5 * 14),
    kit.place("coral", 36, H - 8 * 14 - 30, { scale: 1.2 }),
    kit.place("weed-a", 190, H - 18 * 14 - 10, { opacity: 0.9 }),
    kit.place("weed-b", 1620, H - 13 * 14 - 10, { opacity: 0.9 }),
    kit.place("coral", 1780, H - 8 * 14 - 30, { scale: 1.1, flip: true }),
    cross(kit.place("turtle", 0, 0), {
      x: 70,
      y: 170,
      axis: "y",
      from: H + 40,
      to: -tSize.h - 40,
      dur: 120,
    }),
    cross(kit.place("turtle", 0, 0, { scale: 0.8 }), {
      x: 1590,
      y: 560,
      axis: "y",
      from: H + 40,
      to: -tSize.h - 40,
      dur: 104,
    }),
    cross(kit.place("manta", 0, 0, { opacity: 0.7 }), {
      x: 1190,
      y: 720,
      axis: "y",
      from: H + 40,
      to: -mSize.h - 40,
      dur: 120,
    }),
    swim("f-orange", 640, 300, 92),
    swim("f-blue", 1420, 210, 100, true),
    swim("f-yellow", 250, 830, 82, false, 0.9),
    swim("f-red", 170, 560, 100, false, 0.8),
    `<g>${bubbles.join("")}<animateTransform attributeName="transform" type="translate" values="0 0;0 ${-H}" dur="96s" repeatCount="indefinite"/></g>`,
  ].join("");
  return {
    id: "reef",
    name: "Reef",
    tone: "dark",
    canvas: "#0b3b46",
    accent: "#4fd6d2",
    tuning: { dim: 10, panelBlur: 6, surfaceOpacity: 52 },
    svg: build({
      kit,
      canvas: "#0b3b46",
      sky: [
        [0, "#1c8a96"],
        [0.45, "#10606e"],
        [1, "#073641"],
      ],
      extraDefs: `${shaft.defs}<radialGradient id="light" cx=".1" cy="0" r=".9"><stop offset="0" stop-color="#8ff5ee" stop-opacity=".38"/><stop offset="1" stop-color="#8ff5ee" stop-opacity="0"/></radialGradient>`,
      body,
    }),
  };
}

function koi(): WallpaperScene {
  const kit = new PixelKit(14, 0x0c01);
  const rng = mulberry32(0x0c0e);
  const kpal = {
    w: "#f3e9d2",
    o: "#ee9c45",
    r: "#c9412e",
    t: "#f2d5a8aa",
    f: "#f2d5a8aa",
    e: "#20150c",
  };
  const kA = kit.sprite("koi-a", koiSprite("w", ["r", "o"], 11, kpal));
  const kB = kit.sprite("koi-b", koiSprite("o", ["w", "r"], 23, kpal));
  const kC = kit.sprite("koi-c", koiSprite("w", ["o", "o", "r"], 37, kpal));
  const padPal = { l: "#80d65c", g: "#4fa84b", d: "#2c7340" };
  const pads: Array<[string, number, number, number, number]> = [
    ["pad1", 12, 0.5, 50, 70],
    ["pad2", 14, 2.4, 1690, 90],
    ["pad3", 12, 4.0, 1610, 560],
    ["pad4", 14, 1.2, 30, 600],
    ["pad5", 10, 3.3, 1420, 930],
    ["pad6", 9, 5.2, 240, 960],
    ["pad7", 8, 0.2, 560, 40],
  ];
  kit.sprite("lotus", LOTUS);
  const padUses: string[] = [];
  for (const [name, d, notch, x, y] of pads) {
    kit.sprite(name, padSprite(d, notch, padPal));
    padUses.push(kit.place(name, x, y));
  }
  const lotus1 = kit.place("lotus", 50 + (12 * 14 - 126) / 2, 70 + 20);
  const lotus2 = kit.place("lotus", 30 + (14 * 14 - 126) / 2, 600 + 34, { scale: 1 });
  kit.sprite("ring", ringSprite(6));
  kit.sprite("ring-b", ringSprite(10));
  kit.sprite("petal", { rows: ["p"], pal: { p: "#f6a9cc" } });
  const petals = [
    [420, 140],
    [1240, 330],
    [700, 980],
    [1500, 800],
    [330, 480],
  ]
    .map(([x, y]) => kit.place("petal", x as number, y as number, { opacity: 0.8 }))
    .join("");
  const shaft = shaftLayer("#d8ffd0", [
    { x: 330, w: 300, op: 0.09 },
    { x: 1000, w: 220, op: 0.06 },
    { x: 1450, w: 380, op: 0.08 },
  ]);
  const swim = (
    name: string,
    w: number,
    x: number,
    y: number,
    dur: number,
    left: boolean,
    scale = 1,
  ) =>
    cross(kit.place(name, 0, 0, { flip: left, scale }), {
      x,
      y,
      from: left ? W + 60 : -w * scale - 60,
      to: left ? -w * scale - 60 : W + 60,
      dur,
    });
  const body = [
    shaft.body,
    specks(rng, { count: 60, fill: "#bfe8b0", glyphs: ".:,'", size: 9, opacity: 0.3 }),
    kit.place("ring", 760, 250, { opacity: 0.2 }),
    kit.place("ring-b", 720, 230, { opacity: 0.1 }),
    kit.place("ring", 1180, 640, { opacity: 0.16 }),
    kit.place("ring-b", 1140, 620, { opacity: 0.09 }),
    ...padUses,
    lotus1,
    lotus2,
    petals,
    swim("koi-a", kA.w, 130, 330, 110, false, 0.9),
    swim("koi-b", kB.w, 1250, 880, 100, true, 0.9),
    swim("koi-c", kC.w, 980, 120, 120, false, 0.65),
  ].join("");
  return {
    id: "koi",
    name: "Koi pond",
    tone: "dark",
    canvas: "#10291f",
    accent: "#f08cba",
    tuning: { dim: 10, panelBlur: 5, surfaceOpacity: 52 },
    svg: build({
      kit,
      canvas: "#10291f",
      sky: [
        [0, "#3b705a"],
        [0.5, "#1d4b39"],
        [1, "#0f2a21"],
      ],
      extraDefs: shaft.defs,
      body,
    }),
  };
}

function abyss(): WallpaperScene {
  const kit = new PixelKit(14, 0xab15);
  const rng = mulberry32(0xab16);
  const bg = "#071a38";
  const jellies: Array<[string, number, number, string, number, number, number, number]> = [
    ["jelly-a", 22, 24, "#f08ac4", 5, 60, 700, 26],
    ["jelly-b", 14, 18, "#9c7be0", 6, 500, 60, 34],
    ["jelly-c", 10, 14, "#f2a56a", 7, 1700, 320, 30],
    ["jelly-d", 8, 11, "#6fd6e6", 8, 1480, 840, 42],
  ];
  const bob = jellies.map(([name, w, tent, base, seed, x, y, dur]) => {
    kit.sprite(name, jellySprite(w, tent, base, bg, seed));
    return sway(kit.place(name, 0, 0), { x, y, dx: 0, dy: -24, dur });
  });
  const mound = hillSprite(46, 8, (x) => 8 * Math.sqrt(Math.max(0, 1 - ((x - 22.5) / 23) ** 2)), {
    top: "#2f6a8a",
    body: "#1e4e70",
    deep: "#143a5a",
  });
  kit.sprite("mound", mound);
  const shaft = shaftLayer("#6fc0ff", [
    { x: 330, w: 300, op: 0.07 },
    { x: 1000, w: 220, op: 0.045 },
    { x: 1450, w: 380, op: 0.06 },
  ]);
  const body = [
    shaft.body,
    sway(specks(rng, { count: 90, fill: "#a8d4ff", glyphs: ".:'", size: 9, opacity: 0.4 }), {
      x: 0,
      y: 0,
      dx: 14,
      dy: -22,
      dur: 60,
    }),
    kit.place("mound", 1020, H - 8 * 14, { opacity: 0.8 }),
    ...bob,
  ].join("");
  return {
    id: "abyss",
    name: "Abyss",
    tone: "dark",
    canvas: bg,
    accent: "#a98bf0",
    tuning: { dim: 8, panelBlur: 6, surfaceOpacity: 48 },
    svg: build({
      kit,
      canvas: bg,
      sky: [
        [0, "#10497c"],
        [0.45, "#09294f"],
        [1, "#030b22"],
      ],
      extraDefs: shaft.defs,
      body,
    }),
  };
}

function shallows(): WallpaperScene {
  const kit = new PixelKit(14, 0x5a11);
  const rng = mulberry32(0x5a12);
  const stonePal = { l: "#d7e0de", m: "#aebbba", d: "#7f9091", x: "#95a5a5" };
  const stones: Array<[number, number, number, number, number, number]> = [
    [8, 4.5, -0.25, 90, 110, 1],
    [5, 7.5, 0.35, 1500, 60, 2],
    [9, 5, 0.5, 1560, 700, 3],
    [8, 4.2, -0.5, 30, 820, 4],
    [6, 3.4, 0.15, 1150, 990, 5],
    [4.5, 3, 0.8, 330, 980, 6],
    [3, 2, -0.3, 1790, 420, 7],
    [3.4, 2.2, 0.4, 560, 120, 8],
  ];
  const stoneUses = stones.map(([rx, ry, ang, x, y, seed]) => {
    kit.sprite(`stone${seed}`, stoneSprite(rx, ry, ang, stonePal, seed));
    return kit.place(`stone${seed}`, x, y);
  });
  kit.sprite("f-brown", FISH_BROWN);
  kit.sprite("ring-s", ringSprite(4));
  kit.sprite("ring-m", ringSprite(7));
  kit.sprite("ring-l", ringSprite(11));
  const shaft = shaftLayer("#e4fffa", [
    { x: 320, w: 320, op: 0.12 },
    { x: 1000, w: 220, op: 0.08 },
    { x: 1440, w: 380, op: 0.1 },
  ]);
  const swim = (x: number, y: number, dur: number, left: boolean, scale: number) => {
    const w = kit.size("f-brown").w * scale;
    return cross(kit.place("f-brown", 0, 0, { flip: left, scale }), {
      x,
      y,
      from: left ? W + 60 : -w - 60,
      to: left ? -w - 60 : W + 60,
      dur,
    });
  };
  const body = [
    shaft.body,
    specks(rng, { count: 90, fill: "#e4fffa", glyphs: ".:,'", size: 9, opacity: 0.4 }),
    kit.place("ring-m", 330, 330, { opacity: 0.3 }),
    kit.place("ring-l", 300, 310, { opacity: 0.14 }),
    pulse(`${kit.place("ring-s", 1330, 520)}${kit.place("ring-m", 1300, 505, { opacity: 0.6 })}`, {
      a: 0.32,
      b: 0.1,
      dur: 26,
    }),
    pulse(`${kit.place("ring-m", 1040, 960)}${kit.place("ring-l", 1010, 940, { opacity: 0.5 })}`, {
      a: 0.26,
      b: 0.08,
      dur: 34,
      begin: -9,
    }),
    ...stoneUses,
    swim(820, 380, 96, false, 1.05),
    swim(1300, 880, 110, true, 0.95),
    swim(400, 700, 84, false, 0.85),
  ].join("");
  return {
    id: "shallows",
    name: "Shallows",
    tone: "dark",
    canvas: "#1d4a52",
    accent: "#f0a46a",
    tuning: { dim: 10, panelBlur: 6, surfaceOpacity: 54 },
    svg: build({
      kit,
      canvas: "#1d4a52",
      sky: [
        [0, "#69b5b0"],
        [0.5, "#2f6e76"],
        [1, "#173f48"],
      ],
      extraDefs: shaft.defs,
      body,
    }),
  };
}

function grassLayer(o: {
  seed: number;
  rows: number;
  size: number;
  pitch: number;
  fill: string;
  opacity: number;
  base: number;
  spread: number;
  bottom: number;
}): string {
  const rng = mulberry32(o.seed);
  const cols = Math.round(1960 / (o.size * 0.6));
  const heights: number[] = [];
  let carry = o.base;
  for (let c = 0; c < cols; c += 1) {
    carry = carry * 0.3 + (o.base + rng() ** 1.7 * o.spread) * 0.7;
    heights.push(rng() < 0.08 ? Math.round(o.rows * (0.75 + rng() * 0.25)) : Math.round(carry));
  }
  const blades = "|||l|I!/|i1";
  const lines: string[] = [];
  for (let r = o.rows - 1; r >= 0; r -= 1) {
    let line = "";
    for (let c = 0; c < cols; c += 1) {
      const h = heights[c] ?? 0;
      line +=
        h > r
          ? h - 1 === r
            ? "'.:`".charAt(c % 4)
            : blades.charAt((c * 7 + r * 3) % blades.length)
          : " ";
    }
    const y = o.bottom - r * o.pitch;
    lines.push(
      `<text x="0" y="${y}" textLength="1960" lengthAdjust="spacing">${escapeXml(line)}</text>`,
    );
  }
  return `<g xml:space="preserve" font-size="${o.size}" fill="${o.fill}" opacity="${o.opacity}">${lines.join("")}</g>`;
}

function fireflies(): WallpaperScene {
  const kit = new PixelKit(12, 0xf1f1);
  const rng = mulberry32(0xf1f2);
  kit.sprite("fly", { rows: ["yY"], pal: { y: "#dcf050", Y: "#f6ff9a" } });
  const spots: Array<[number, number]> = [
    [260, 520],
    [440, 300],
    [300, 770],
    [1500, 430],
    [1650, 640],
    [1390, 830],
    [1730, 290],
    [150, 340],
    [1100, 880],
  ];
  const group = (idx: number[], dur: number, begin: number, drift: number) =>
    sway(
      pulse(
        idx
          .map((i) => {
            const [x, y] = spots[i] as [number, number];
            return `<circle cx="${x + 17}" cy="${y + 8}" r="64" fill="url(#halo)"/>${kit.place("fly", x, y, { scale: 1.4 })}`;
          })
          .join(""),
        { a: 0.5, b: 1, dur, begin },
      ),
      { x: 0, y: 0, dx: drift, dy: -drift * 0.6, dur: dur * 2 },
    );
  const shaft = shaftLayer("#a8f0b8", [
    { x: 330, w: 300, op: 0.05 },
    { x: 1000, w: 220, op: 0.035 },
    { x: 1450, w: 380, op: 0.045 },
  ]);
  const body = [
    shaft.body,
    specks(rng, { count: 70, fill: "#8fd6a0", glyphs: ".:'", size: 8, opacity: 0.28, y1: 1000 }),
    grassLayer({
      seed: 1,
      rows: 11,
      size: 11,
      pitch: 13,
      fill: "#1f5238",
      opacity: 0.85,
      base: 2,
      spread: 8,
      bottom: H - 6,
    }),
    grassLayer({
      seed: 2,
      rows: 15,
      size: 13,
      pitch: 16,
      fill: "#2f8458",
      opacity: 0.8,
      base: 2,
      spread: 10,
      bottom: H - 2,
    }),
    grassLayer({
      seed: 3,
      rows: 11,
      size: 16,
      pitch: 20,
      fill: "#56bb78",
      opacity: 0.7,
      base: 1,
      spread: 8,
      bottom: H + 8,
    }),
    group([0, 3, 5], 22, 0, 24),
    group([1, 4, 8], 28, -7, -30),
    group([2, 6, 7], 34, -15, 20),
  ].join("");
  return {
    id: "fireflies",
    name: "Fireflies",
    tone: "dark",
    canvas: "#08150f",
    accent: "#c9e84a",
    tuning: { dim: 6, panelBlur: 5, surfaceOpacity: 46 },
    svg: build({
      kit,
      canvas: "#08150f",
      sky: [
        [0, "#0e2a1f"],
        [0.6, "#0a1c14"],
        [1, "#06110c"],
      ],
      extraDefs: `${shaft.defs}${glow("halo", "#d6f04a", 0.55)}`,
      body,
    }),
  };
}

function moonlit(): WallpaperScene {
  const kit = new PixelKit(14, 0x300e);
  const rng = mulberry32(0x300f);
  const moon = kit.sprite("moon", moonSprite(8));
  const nightPal = { w: "#4a5ea8", s: "#394b92", b: "#2a3977" };
  const clouds: Array<[string, number, number, number]> = [
    ["nc1", 38, 7, 21],
    ["nc2", 34, 7, 22],
    ["nc3", 30, 6, 23],
  ];
  const sizes = new Map<string, { w: number; h: number }>();
  for (const [name, w, h, seed] of clouds)
    sizes.set(name, kit.sprite(name, cloudSprite(w, h, seed, nightPal, 0.75)));
  const drift = (name: string, x: number, y: number, dur: number, opacity: number) => {
    const size = sizes.get(name);
    if (!size) throw new Error(name);
    return cross(kit.place(name, 0, 0, { opacity }), { x, y, from: -size.w - 40, to: W + 40, dur });
  };
  const shaft = shaftLayer("#8ea6ff", [
    { x: 330, w: 320, op: 0.05 },
    { x: 1000, w: 220, op: 0.035 },
    { x: 1460, w: 380, op: 0.05 },
  ]);
  const mx = 1490;
  const my = 130;
  const body = [
    shaft.body,
    specks(rng, { count: 190, fill: "#c9d4ff", glyphs: ".+'`*", size: 9, opacity: 0.5, y1: 900 }),
    specks(rng, { count: 30, fill: "#f4e6b0", glyphs: ".+*", size: 11, opacity: 0.5, y1: 700 }),
    pulse(
      specks(rng, { count: 10, fill: "#ffffff", glyphs: "+*", size: 12, opacity: 0.9, y1: 800 }),
      {
        a: 0.9,
        b: 0.3,
        dur: 24,
      },
    ),
    pulse(
      specks(rng, { count: 9, fill: "#dfe6ff", glyphs: "+*.", size: 12, opacity: 0.9, y1: 800 }),
      {
        a: 0.8,
        b: 0.25,
        dur: 31,
        begin: -8,
      },
    ),
    pulse(
      `<circle cx="${mx + moon.w / 2}" cy="${my + moon.h / 2}" r="420" fill="url(#moonglow)"/>`,
      {
        a: 0.75,
        b: 1,
        dur: 40,
      },
    ),
    kit.place("moon", mx, my),
    drift("nc1", 150, 260, 120, 0.85),
    drift("nc2", 1330, 520, 108, 0.8),
    kit.place("nc3", 720, 840, { opacity: 0.55 }),
  ].join("");
  return {
    id: "moonlit",
    name: "Moonlit",
    tone: "dark",
    canvas: "#0b1230",
    accent: "#e8d9a0",
    tuning: { dim: 8, panelBlur: 6, surfaceOpacity: 50 },
    svg: build({
      kit,
      canvas: "#0b1230",
      sky: [
        [0, "#050816"],
        [0.5, "#0c1634"],
        [1, "#1d2f6e"],
      ],
      extraDefs: `${shaft.defs}${glow("moonglow", "#f4e6b0", 0.4)}`,
      body,
    }),
  };
}

export function buildPixelScenes(): WallpaperScene[] {
  return [
    dusk(),
    daydream(),
    reef(),
    koi(),
    abyss(),
    shallows(),
    fireflies(),
    moonlit(),
    buildGlyphscapeScene(),
  ];
}
