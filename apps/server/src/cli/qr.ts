const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] ?? 0;
}

function mul(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[(LOG[left] ?? 0) + (LOG[right] ?? 0)] ?? 0;
}

function eccGenerator(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      const term = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ term;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(term, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

function remainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const ecc = new Uint8Array(generator.length - 1);
  for (const byte of data) {
    const factor = byte ^ (ecc[0] ?? 0);
    ecc.copyWithin(0, 1);
    ecc[ecc.length - 1] = 0;
    if (factor === 0) continue;
    for (let i = 0; i < ecc.length; i += 1) {
      ecc[i] = (ecc[i] ?? 0) ^ mul(generator[i + 1] ?? 0, factor);
    }
  }
  return ecc;
}

interface Version {
  version: number;
  size: number;
  data: number;
  ecc: number;
  remainder: number;
  align: number[];
}

const VERSIONS: Version[] = [
  { version: 1, size: 21, data: 19, ecc: 7, remainder: 0, align: [] },
  { version: 2, size: 25, data: 34, ecc: 10, remainder: 7, align: [6, 18] },
  { version: 3, size: 29, data: 55, ecc: 15, remainder: 7, align: [6, 22] },
  { version: 4, size: 33, data: 80, ecc: 20, remainder: 7, align: [6, 26] },
  { version: 5, size: 37, data: 108, ecc: 26, remainder: 7, align: [6, 30] },
];

function chooseVersion(byteLength: number): Version {
  for (const version of VERSIONS) {
    const bits = 4 + 8 + byteLength * 8;
    if (bits <= version.data * 8) return version;
  }
  throw new Error("That link is too long for the pairing QR code.");
}

function dataCodewords(text: string, version: Version): Uint8Array {
  const bytes = [...Buffer.from(text)];
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const capacity = version.data * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [0xec, 0x11];
  let pad = 0;
  while (bits.length < capacity) {
    push(pads[pad % 2] ?? 0, 8);
    pad += 1;
  }
  const out = new Uint8Array(version.data);
  for (let i = 0; i < out.length; i += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (bits[i * 8 + bit] ?? 0);
    out[i] = value;
  }
  return out;
}

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  let remainderBits = data << 10;
  const generator = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if (((remainderBits >>> i) & 1) !== 0) remainderBits ^= generator << (i - 10);
  }
  return ((data << 10) | remainderBits) ^ 0b101010000010010;
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function blank(size: number): { modules: boolean[][]; fn: boolean[][] } {
  return {
    modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    fn: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
  };
}

function paint(
  modules: boolean[][],
  fn: boolean[][],
  row: number,
  col: number,
  dark: boolean,
): void {
  const line = modules[row];
  const used = fn[row];
  if (!line || !used || used[col]) return;
  line[col] = dark;
  used[col] = true;
}

function drawFinder(modules: boolean[][], fn: boolean[][], row: number, col: number, size: number) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || x < 0 || y >= size || x >= size) continue;
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      paint(modules, fn, y, x, inside && (edge || core));
    }
  }
}

function overlapsFinder(row: number, col: number, size: number): boolean {
  const inFinder = (y: number, x: number) =>
    (y < 9 && x < 9) || (y < 9 && x >= size - 8) || (y >= size - 8 && x < 9);
  return inFinder(row, col);
}

function drawAlignment(modules: boolean[][], fn: boolean[][], version: Version) {
  for (const row of version.align) {
    for (const col of version.align) {
      if (overlapsFinder(row, col, version.size)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          paint(modules, fn, row + r, col + c, dark);
        }
      }
    }
  }
}

function drawTiming(modules: boolean[][], fn: boolean[][], size: number) {
  for (let i = 0; i < size; i += 1) {
    paint(modules, fn, 6, i, i % 2 === 0);
    paint(modules, fn, i, 6, i % 2 === 0);
  }
}

function reserveFormat(fn: boolean[][], size: number) {
  for (let i = 0; i < 9; i += 1) {
    const row = fn[8];
    const col = fn[i];
    if (row) row[i] = true;
    if (col) col[8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    const vertical = fn[size - 1 - i];
    const horizontal = fn[8];
    if (vertical) vertical[8] = true;
    if (horizontal) horizontal[size - 1 - i] = true;
  }
  const darkRow = fn[size - 8];
  if (darkRow) darkRow[8] = true;
}

function placeData(modules: boolean[][], fn: boolean[][], bits: number[]) {
  const size = modules.length;
  let index = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = col - offset;
        if (fn[row]?.[x]) continue;
        const line = modules[row];
        if (!line) continue;
        line[x] = index < bits.length ? bits[index] === 1 : false;
        index += 1;
      }
    }
    upward = !upward;
  }
}

function applyFormat(modules: boolean[][], format: number, size: number) {
  const bit = (i: number) => ((format >>> i) & 1) === 1;
  const set = (row: number, col: number, dark: boolean) => {
    const line = modules[row];
    if (line) line[col] = dark;
  };
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(size - 8, 8, true);
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const darkAt = (row: number, col: number) => modules[row]?.[col] === true;
  for (let row = 0; row < size; row += 1) {
    let run = 1;
    for (let col = 1; col < size; col += 1) {
      if (darkAt(row, col) === darkAt(row, col - 1)) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let col = 0; col < size; col += 1) {
    let run = 1;
    for (let row = 1; row < size; row += 1) {
      if (darkAt(row, col) === darkAt(row - 1, col)) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = darkAt(row, col);
      if (
        value === darkAt(row, col + 1) &&
        value === darkAt(row + 1, col) &&
        value === darkAt(row + 1, col + 1)
      ) {
        score += 3;
      }
    }
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function clone(modules: boolean[][]): boolean[][] {
  return modules.map((row) => [...row]);
}

/** Byte-mode QR, error correction L, versions 1–5. True means a dark module. */
export function encodeQr(text: string): boolean[][] {
  const version = chooseVersion(Buffer.byteLength(text));
  const data = dataCodewords(text, version);
  const ecc = remainder(data, eccGenerator(version.ecc));
  const codewords = new Uint8Array(data.length + ecc.length);
  codewords.set(data);
  codewords.set(ecc, data.length);
  const bits: number[] = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }
  for (let i = 0; i < version.remainder; i += 1) bits.push(0);

  const { modules, fn } = blank(version.size);
  drawFinder(modules, fn, 0, 0, version.size);
  drawFinder(modules, fn, 0, version.size - 7, version.size);
  drawFinder(modules, fn, version.size - 7, 0, version.size);
  drawAlignment(modules, fn, version);
  drawTiming(modules, fn, version.size);
  reserveFormat(fn, version.size);
  placeData(modules, fn, bits);

  let best = modules;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = clone(modules);
    for (let row = 0; row < version.size; row += 1) {
      for (let col = 0; col < version.size; col += 1) {
        if (fn[row]?.[col]) continue;
        if (!maskBit(mask, row, col)) continue;
        const line = candidate[row];
        if (line) line[col] = !line[col];
      }
    }
    applyFormat(candidate, formatBits(mask), version.size);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Unicode half-blocks, black on white, with a four-module quiet zone. */
export function renderQr(text: string): string {
  const matrix = encodeQr(text);
  const quiet = 4;
  const width = matrix.length + quiet * 2;
  const height = width;
  const dark = (row: number, col: number) => {
    if (row < quiet || col < quiet || row >= height - quiet || col >= width - quiet) return false;
    return matrix[row - quiet]?.[col - quiet] === true;
  };
  const ink = "\x1b[38;2;0;0;0;48;2;255;255;255m";
  const reset = "\x1b[0m";
  const lines: string[] = [];
  for (let row = 0; row < height; row += 2) {
    let line = ink;
    for (let col = 0; col < width; col += 1) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      if (top && bottom) line += "█";
      else if (top) line += "▀";
      else if (bottom) line += "▄";
      else line += " ";
    }
    line += reset;
    lines.push(line);
  }
  return lines.join("\n");
}
