import { Grid, mix, type SpriteDef } from "./pixel-kit.ts";
import { mulberry32 } from "./scenes.ts";

// Sprites are ASCII maps ("." is empty) plus a palette. Hand-drawn maps are written out;
// round shapes (suns, stones, pads, domes, hills) come from Grid primitives.

export const BIRD: SpriteDef = {
  rows: ["k.....k", ".kk.kk.", "...k..."],
  pal: { k: "#2b5f8f" },
};

export const BUBBLE: SpriteDef = {
  rows: ["o"],
  pal: { o: "#bdf0ffcc" },
};

export const FISH_ORANGE: SpriteDef = {
  rows: [
    "....OOO.....",
    "..OOOOOOO.tt",
    ".OOooooooottT",
    "OOoooeooootTT",
    ".lloooooolttT",
    "..lllllllllt.",
    "....lll.....",
  ],
  pal: { O: "#d9732f", o: "#f2a04a", l: "#ffd89a", e: "#2a1408", t: "#c75a22", T: "#a8431a" },
};

export const FISH_BLUE: SpriteDef = {
  rows: ["...BBB...", ".BBbbbBB.t", "BBbebbbbtt", ".llbbbbbt.", "...lll..."],
  pal: { B: "#3a8fd0", b: "#6fc0ee", l: "#d4f0ff", e: "#0d2438", t: "#2c6fa6" },
};

export const FISH_YELLOW: SpriteDef = {
  rows: ["..yyyy..", ".yYyyyyt", "yyeyyytt", ".yyyyyt.", "..yyyy.."],
  pal: { y: "#f1d24f", Y: "#fff0a0", e: "#3a2a05", t: "#c9a52a" },
};

export const FISH_RED: SpriteDef = {
  rows: ["..rrrr..", ".rrRrrrt", "rrerrrtt", ".rrrrrt.", "..rrrr.."],
  pal: { r: "#d94a3a", R: "#f08a70", e: "#2a0a08", t: "#a83024" },
};

export const FISH_BROWN: SpriteDef = {
  rows: ["..bbbb..", ".bbBbbbt", "bbebbbtt", ".bbbbbt.", "..bbbb.."],
  pal: { b: "#a8552f", B: "#c8764a", e: "#210c05", t: "#7d3a1f" },
};

export const LOTUS: SpriteDef = {
  rows: [
    "....L....",
    "...LPL...",
    ".L.PPP.L.",
    ".LPPYPPL.",
    "PPPPYPPPP",
    "pPPPPPPPp",
    ".pPPPPPp.",
    "..ppppp..",
  ],
  pal: { L: "#ffd6ea", P: "#f08cba", p: "#c25a8f", Y: "#ffe27a" },
};

export const CORAL: SpriteDef = {
  rows: [
    "p..p...p..",
    "p..pp..p.p",
    "pp.pp.pp.p",
    ".pppppppp.",
    "..pppppp..",
    "...pPPp...",
    "...pPPp...",
    "..ppPPpp..",
  ],
  pal: { p: "#e0668f", P: "#a83f6a" },
};

/** Disc with rays, shaded centre to rim. */
export function sunSprite(
  r: number,
  pal: { a: string; b: string; c: string; r: string; q: string },
): SpriteDef {
  const size = (r + 9) * 2 + 1;
  const g = new Grid(size, size);
  const c = r + 9;
  const rays = 16;
  for (let i = 0; i < rays; i += 1) {
    const ang = (i / rays) * Math.PI * 2;
    const len = r + (i % 2 === 0 ? 8 : 4);
    for (let d = r - 1; d <= len; d += 1) {
      const x = Math.round(c + Math.cos(ang) * d);
      const y = Math.round(c + Math.sin(ang) * d);
      g.set(x, y, d > len - 2 ? "q" : "r");
      if (d <= r + 2) {
        g.set(
          Math.round(c + Math.cos(ang) * d - Math.sin(ang)),
          Math.round(c + Math.sin(ang) * d + Math.cos(ang)),
          "r",
        );
        g.set(
          Math.round(c + Math.cos(ang) * d + Math.sin(ang)),
          Math.round(c + Math.sin(ang) * d - Math.cos(ang)),
          "r",
        );
      }
    }
  }
  g.ellipse(c, c, r + 0.5, r + 0.5, (nx, ny) => {
    const d = Math.hypot(nx, ny);
    return d < 0.42 ? "a" : d < 0.82 ? "b" : "c";
  });
  return { rows: g.rows(), pal: pal };
}

export function moonSprite(r: number): SpriteDef {
  const size = r * 2 + 3;
  const g = new Grid(size, size);
  const c = r + 1;
  g.ellipse(c, c, r + 0.5, r + 0.5, (nx, ny, x, y) => {
    const hole = Math.hypot(x - (c + r * 0.55), y - (c - r * 0.3));
    if (hole < r * 0.92) return ".";
    const d = Math.hypot(nx, ny);
    return d > 0.82 ? "C" : (x * 7 + y * 13) % 11 === 0 ? "k" : "c";
  });
  return { rows: g.rows(), pal: { C: "#f7efc9", c: "#e4d49a", k: "#bba66c" } };
}

/** Flat-bottomed cumulus built from overlapping domes. `puff` 1 is tall and round, 0.5 is a flat bank. */
export function cloudSprite(
  w: number,
  h: number,
  seed: number,
  pal: { w: string; s: string; b: string },
  puff = 1,
): SpriteDef {
  const rng = mulberry32(seed);
  const g = new Grid(w, h);
  const base = h - 2;
  const bumps = Math.max(3, Math.round(w / 6));
  for (let i = 0; i < bumps; i += 1) {
    const t = (i + 0.5) / bumps;
    const edge = Math.sin(t * Math.PI);
    const cx = 3 + t * (w - 6);
    const rx = 3 + rng() * 3.5;
    const ry = Math.max(1.5, (0.35 + 0.65 * edge) * (h - 2) * puff * (0.8 + rng() * 0.2));
    g.ellipse(cx, base, rx, ry, (_nx, _ny, _x, y) => (y >= base - 1 ? "s" : "w"));
  }
  for (let x = 0; x < w; x += 1) {
    if (g.get(x, base) !== ".") {
      g.set(x, base, "s");
      g.set(x, base + 1, "b");
    }
  }
  return { rows: g.rows(), pal };
}

/** Top-down sea turtle, head up. */
export function turtleSprite(pal: {
  g: string;
  G: string;
  d: string;
  s: string;
  S: string;
}): SpriteDef {
  const g = new Grid(24, 26);
  const cx = 11.5;
  g.line(11, 2, 11, 5, "s", 2);
  g.ellipse(cx, 3, 2.2, 2.8, (nx, ny) => (ny < -0.2 ? "s" : "S"));
  g.set(10, 2, "e");
  g.set(13, 2, "e");
  for (const side of [-1, 1]) {
    const x = (d: number) => cx + side * d;
    g.poly(
      [
        [x(4), 7],
        [x(8), 7.5],
        [x(11.6), 13],
        [x(11), 15.5],
        [x(7), 12.5],
        [x(4), 11],
      ],
      "S",
    );
    g.poly(
      [
        [x(5), 8],
        [x(8), 8.4],
        [x(10.6), 12.4],
        [x(7.4), 11],
      ],
      "s",
    );
    g.poly(
      [
        [x(4), 19],
        [x(8.4), 22],
        [x(8.6), 25],
        [x(5), 23.4],
      ],
      "S",
    );
  }
  g.line(11, 22, 11, 25, "S", 2);
  g.ellipse(cx, 14.2, 7, 8.4, (nx, ny) => {
    const d = Math.hypot(nx, ny);
    if (d > 0.82) return "d";
    if (d < 0.32) return "G";
    const a = Math.atan2(ny, nx);
    return Math.abs(Math.sin(a * 3)) > 0.93 ? "d" : "g";
  });
  return { rows: g.rows(), pal: { ...pal, e: "#14160c" } };
}

/** Manta ray seen from above, head up, tail down. */
export function mantaSprite(pal: { b: string; B: string; d: string }): SpriteDef {
  const g = new Grid(42, 32);
  g.poly(
    [
      [21, 0],
      [24, 3],
      [30, 7],
      [42, 13],
      [42, 15.5],
      [33, 16.5],
      [26, 20],
      [22.6, 30],
      [21, 31],
    ],
    (x, y) => (y < 4 || (x < 26 && y < 19) ? "B" : y >= 13 && x > 34 ? "d" : "b"),
  );
  g.mirrorX();
  g.set(19, 3, "d");
  g.set(22, 3, "d");
  return { rows: g.rows(), pal };
}

/** Top-down koi facing right. `pat` picks body and spot characters. */
export function koiSprite(
  body: "w" | "o" | "k",
  spots: ReadonlyArray<"w" | "o" | "r" | "k">,
  seed: number,
  pal: Record<string, string>,
): SpriteDef {
  const rng = mulberry32(seed);
  const w = 28;
  const h = 11;
  const g = new Grid(w, h);
  const mid = 5;
  const half = (x: number): number => {
    if (x < 4) return 1 + x * 0.9;
    if (x < 8) return 3.4 - (x - 4) * 0.05;
    if (x < 20) return 3 + Math.sin(((x - 8) / 12) * Math.PI) * 1.5;
    return 4.2 - (x - 20) * 0.55;
  };
  for (let x = 4; x < w - 1; x += 1) {
    const hw = half(x);
    for (let y = 0; y < h; y += 1) if (Math.abs(y - mid) <= hw - 0.2) g.set(x, y, body);
  }
  g.poly(
    [
      [0, 1.2],
      [5, 4.6],
      [5, 6.4],
      [0, 9.8],
      [2, mid],
    ],
    "t",
  );
  g.poly(
    [
      [16, 0],
      [20, 2.4],
      [17, 3.4],
    ],
    "f",
  );
  g.poly(
    [
      [16, 10.2],
      [20, 7.6],
      [17, 6.6],
    ],
    "f",
  );
  for (let i = 0; i < 4; i += 1) {
    const sx = 8 + rng() * 14;
    const sy = mid + (rng() - 0.5) * 3.4;
    const ch = spots[i % spots.length] as string;
    g.ellipse(sx, sy, 1.6 + rng() * 2.2, 1 + rng() * 1.2, (_nx, _ny, x, y) =>
      g.get(x, y) === body ? ch : g.get(x, y),
    );
  }
  g.set(w - 5, mid - 2, "e");
  g.set(w - 5, mid + 2, "e");
  return { rows: g.rows(), pal };
}

export function padSprite(
  d: number,
  notch: number,
  pal: { l: string; g: string; d: string },
): SpriteDef {
  const g = new Grid(d, d);
  const c = (d - 1) / 2;
  g.ellipse(c, c, d / 2, d / 2, (nx, ny, x) => {
    const dist = Math.hypot(nx, ny);
    const a = Math.atan2(ny, nx);
    if (dist > 0.25 && Math.abs(Math.atan2(Math.sin(a - notch), Math.cos(a - notch))) < 0.22)
      return ".";
    if (dist > 0.82) return "d";
    return nx + ny < -0.5 && dist < 0.7 ? "l" : x === Math.round(c) && ny > 0 ? "d" : "g";
  });
  return { rows: g.rows(), pal };
}

export function ringSprite(r: number, squash = 0.6): SpriteDef {
  const ry = Math.max(2, Math.round(r * squash));
  const g = new Grid(r * 2 + 3, ry * 2 + 3);
  const cx = r + 1;
  const cy = ry + 1;
  for (let i = 0; i < 72; i += 1) {
    const a = (i / 72) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * ry);
    if ((x + y) % 2 === 0) g.set(x, y, "r");
  }
  return { rows: g.rows(), pal: { r: "#ffffffff" } };
}

/** River stone: rotated ellipse lit from the upper left. */
export function stoneSprite(
  rx: number,
  ry: number,
  angle: number,
  pal: { l: string; m: string; d: string; x: string },
  seed: number,
): SpriteDef {
  const rng = mulberry32(seed);
  const reach = Math.ceil(Math.max(rx, ry)) + 1;
  const g = new Grid(reach * 2 + 1, reach * 2 + 1);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let y = 0; y < g.h; y += 1) {
    for (let x = 0; x < g.w; x += 1) {
      const dx = x - reach;
      const dy = y - reach;
      const u = (dx * ca + dy * sa) / rx;
      const v = (-dx * sa + dy * ca) / ry;
      const d = Math.hypot(u, v);
      if (d > 1) continue;
      const lit = -(dx + dy) / (reach * 1.4);
      g.set(
        x,
        y,
        d > 0.84
          ? lit < 0
            ? "d"
            : "m"
          : lit > 0.18
            ? "l"
            : lit < -0.22
              ? "d"
              : rng() < 0.07
                ? "x"
                : "m",
      );
    }
  }
  return { rows: g.rows(), pal };
}

/** Jellyfish: domed bell with a frilled underside and wavering tentacles. */
export function jellySprite(
  w: number,
  tentacle: number,
  base: string,
  bg: string,
  seed: number,
): SpriteDef {
  const rng = mulberry32(seed);
  const domeH = Math.round(w * 0.5);
  const g = new Grid(w + 2, domeH + tentacle + 2);
  const cx = (w + 1) / 2;
  g.ellipse(cx, domeH, w / 2, domeH - 0.2, (nx, ny, _x, y) => {
    if (y > domeH) return ".";
    const d = Math.hypot(nx, ny);
    if (ny > -0.1) return "r";
    return d > 0.8 ? "m" : ny < -0.55 && nx < 0.1 ? "h" : "b";
  });
  for (let x = 1; x <= w; x += 1)
    if (g.get(x, domeH) !== ".") g.set(x, domeH + 1, x % 2 === 1 ? "r" : "m");
  const cols: number[] = [];
  for (let x = 2; x < w; x += 2) cols.push(x);
  for (const x0 of cols) {
    const phase = x0 * 0.12 + rng() * 0.5;
    const len = tentacle - Math.floor(rng() * 5);
    for (let i = 0; i < len; i += 1) {
      const x = Math.round(x0 + Math.sin(i * 0.33 + phase) * 1.1);
      g.set(x, domeH + 2 + i, i > len * 0.62 ? "u" : i > len * 0.3 ? "t" : "T");
    }
  }
  return {
    rows: g.rows(),
    pal: {
      h: mix(base, "#ffffff", 0.45),
      b: base,
      m: mix(base, bg, 0.3),
      r: mix(base, bg, 0.5),
      T: mix(base, bg, 0.22),
      t: mix(base, bg, 0.4),
      u: mix(base, bg, 0.62),
    },
  };
}

/** Low mound/dune strip. `heights` returns the column height in tiles. */
export function hillSprite(
  w: number,
  h: number,
  heights: (x: number) => number,
  pal: { top: string; body: string; deep: string },
): SpriteDef {
  const g = new Grid(w, h);
  for (let x = 0; x < w; x += 1) {
    const top = Math.max(0, Math.round(h - heights(x)));
    for (let y = top; y < h; y += 1) g.set(x, y, y === top ? "t" : y > h - 3 ? "d" : "b");
  }
  return { rows: g.rows(), pal: { t: pal.top, b: pal.body, d: pal.deep } };
}

export function seaweedSprite(h: number, seed: number, pal: { a: string; b: string }): SpriteDef {
  const rng = mulberry32(seed);
  const g = new Grid(9, h);
  const phase = rng() * 6;
  for (let y = 0; y < h; y += 1) {
    const x = Math.round(4 + Math.sin(y * 0.55 + phase) * 2.2);
    g.set(x, y, "a");
    g.set(x + 1, y, "b");
    if (y % 5 === 2) {
      g.set(x - 1, y, "a");
      g.set(x + 2, y, "b");
    }
  }
  return { rows: g.rows(), pal };
}
