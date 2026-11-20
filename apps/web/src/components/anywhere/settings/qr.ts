/* oxlint-disable typescript/no-non-null-assertion */
/**
 * QR Code encoder, byte mode, error correction M, versions 1–10.
 * Enough for a pairing URL. No lookup tables beyond the spec's constants.
 */

export interface QrMatrix {
  size: number;
  /** Row-major. True is a dark module. */
  modules: boolean[][];
}

/** Medium error correction. `ecc` is per block; `blocks` is the block count; `data` is the data codeword count. */
const MEDIUM: { ecc: number; blocks: number; data: number }[] = [
  { ecc: 0, blocks: 0, data: 0 },
  { ecc: 10, blocks: 1, data: 16 },
  { ecc: 16, blocks: 1, data: 28 },
  { ecc: 26, blocks: 1, data: 44 },
  { ecc: 18, blocks: 2, data: 64 },
  { ecc: 24, blocks: 2, data: 86 },
  { ecc: 16, blocks: 4, data: 108 },
  { ecc: 18, blocks: 4, data: 124 },
  { ecc: 22, blocks: 4, data: 154 },
  { ecc: 22, blocks: 5, data: 182 },
  { ecc: 26, blocks: 5, data: 216 },
];

const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const GF = 0x11d;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= GF;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0;
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0;
}

/** Reed-Solomon remainder. `data` is the message; the result is `eccLength` codewords. */
export function reedSolomonRemainder(data: readonly number[], eccLength: number): number[] {
  let generator = [1];
  for (let i = 0; i < eccLength; i++) {
    const next = Array.from({ length: generator.length + 1 }, () => 0);
    const root = EXP[i] ?? 0;
    for (let j = 0; j < generator.length; j++) {
      const term = generator[j] ?? 0;
      // Highest degree first: * x keeps the leading coefficient, * α^i shifts down.
      next[j] = (next[j] ?? 0) ^ term;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(term, root);
    }
    generator = next;
  }
  const rest = Array.from({ length: eccLength }, () => 0);
  for (const byte of data) {
    const factor = byte ^ (rest[0] ?? 0);
    rest.copyWithin(0, 1);
    rest[eccLength - 1] = 0;
    for (let i = 0; i < eccLength; i++) {
      rest[i] = (rest[i] ?? 0) ^ mul(generator[i + 1] ?? 0, factor);
    }
  }
  return rest;
}

function pushBits(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Byte-mode data codewords for one version, including terminator and pad bytes. */
export function byteModeDataCodewords(text: string, version: number): number[] {
  const spec = MEDIUM[version];
  if (!spec) throw new Error(`QR version ${version} is outside 1–10.`);
  const payload = [...new TextEncoder().encode(text)];
  const countBits = version <= 9 ? 8 : 16;
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, payload.length, countBits);
  for (const byte of payload) pushBits(bits, byte, 8);
  const capacity = spec.data * 8;
  if (bits.length > capacity) throw new Error("Text does not fit this QR version.");
  const terminator = Math.min(4, capacity - bits.length);
  pushBits(bits, 0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | (bits[i + j] ?? 0);
    out.push(value);
  }
  const pads = [0xec, 0x11];
  let pad = 0;
  while (out.length < spec.data) out.push(pads[pad++ % 2] ?? 0xec);
  return out;
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version++) {
    const countBits = version <= 9 ? 8 : 16;
    const needed = 4 + countBits + byteLength * 8;
    const spec = MEDIUM[version];
    if (spec && needed <= spec.data * 8) return version;
  }
  throw new Error("That URL is too long for a pairing QR code.");
}

function interleave(data: number[], version: number): number[] {
  const spec = MEDIUM[version];
  if (!spec) throw new Error(`QR version ${version} is outside 1–10.`);
  const count = spec.blocks;
  const shortLength = Math.floor(data.length / count);
  const extra = data.length % count;
  const shortCount = count - extra;
  const blocks: { data: number[]; ecc: number[] }[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const length = i < shortCount ? shortLength : shortLength + 1;
    const chunk = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: chunk, ecc: reedSolomonRemainder(chunk, spec.ecc) });
  }
  const out: number[] = [];
  const longest = shortLength + (extra > 0 ? 1 : 0);
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      const byte = block.data[i];
      if (byte !== undefined) out.push(byte);
    }
  }
  for (let i = 0; i < spec.ecc; i++) {
    for (const block of blocks) out.push(block.ecc[i] ?? 0);
  }
  return out;
}

/** 15-bit format information for error correction M and a mask of 0–7. Mask 0 is 0b101010000010010. */
export function formatInformationBits(mask: number): number {
  const data = mask & 7;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 18-bit version information. Version 7 is 0b000111110010010100. */
export function versionInformationBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

function bitAt(value: number, index: number, width: number): boolean {
  return ((value >>> (width - 1 - index)) & 1) === 1;
}

function maskInverts(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function blank(size: number): { modules: boolean[][]; fn: boolean[][] } {
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  return { modules, fn };
}

function paint(modules: boolean[][], fn: boolean[][], x: number, y: number, dark: boolean) {
  const row = modules[y];
  const mark = fn[y];
  if (!row || !mark || x < 0 || x >= row.length) return;
  row[x] = dark;
  mark[x] = true;
}

function drawFinder(modules: boolean[][], fn: boolean[][], ox: number, oy: number) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const ring = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const core = inside && dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      paint(modules, fn, ox + dx, oy + dy, ring || core);
    }
  }
}

function drawAlignment(modules: boolean[][], fn: boolean[][], cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      paint(modules, fn, cx + dx, cy + dy, dark);
    }
  }
}

function drawFunctionPatterns(version: number): { modules: boolean[][]; fn: boolean[][] } {
  const size = 17 + 4 * version;
  const { modules, fn } = blank(size);
  drawFinder(modules, fn, 0, 0);
  drawFinder(modules, fn, size - 7, 0);
  drawFinder(modules, fn, 0, size - 7);
  const positions = ALIGNMENT[version] ?? [];
  for (const cy of positions) {
    for (const cx of positions) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6))
        continue;
      drawAlignment(modules, fn, cx, cy);
    }
  }
  for (let i = 0; i < size; i++) {
    if (!fn[6]?.[i]) paint(modules, fn, i, 6, i % 2 === 0);
    if (!fn[i]?.[6]) paint(modules, fn, 6, i, i % 2 === 0);
  }
  paint(modules, fn, 8, 4 * version + 9, true);
  for (let i = 0; i < 9; i++) {
    fn[8]![i] = true;
    fn[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    fn[8]![size - 1 - i] = true;
    fn[size - 1 - i]![8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      fn[b]![a] = true;
      fn[a]![b] = true;
    }
  }
  return { modules, fn };
}

function placeData(modules: boolean[][], fn: boolean[][], codewords: readonly number[]) {
  const size = modules.length;
  const bits: boolean[] = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >>> i) & 1) === 1);
  }
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y]?.[x] && index < bits.length) {
          modules[y]![x] = bits[index] ?? false;
          index += 1;
        }
      }
    }
  }
}

function drawFormat(modules: boolean[][], mask: number) {
  const size = modules.length;
  const bits = formatInformationBits(mask);
  const set = (x: number, y: number, index: number) => {
    modules[y]![x] = bitAt(bits, index, 15);
  };
  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8, i);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, i);
}

function drawVersion(modules: boolean[][], version: number) {
  if (version < 7) return;
  const size = modules.length;
  const bits = versionInformationBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = bitAt(bits, i, 18);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b]![a] = dark;
    modules[a]![b] = dark;
  }
}

function applyMask(modules: boolean[][], fn: boolean[][], mask: number) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y]?.[x] && maskInverts(mask, x, y)) modules[y]![x] = !modules[y]![x];
    }
  }
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const runs = (line: boolean[]) => {
    let count = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        count += 1;
        if (count === 5) score += 3;
        else if (count > 5) score += 1;
      } else count = 1;
    }
  };
  for (const row of modules) runs(row);
  for (let x = 0; x < size; x++) runs(modules.map((row) => row[x] ?? false));
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const value = modules[y]?.[x];
      if (
        value === modules[y]?.[x + 1] &&
        value === modules[y + 1]?.[x] &&
        value === modules[y + 1]?.[x + 1]
      )
        score += 3;
    }
  }
  const hunt = (line: boolean[]) => {
    const text = line.map((dark) => (dark ? "1" : "0")).join("");
    for (const pattern of ["10111010000", "00001011101"]) {
      let from = 0;
      while (from < text.length) {
        const found = text.indexOf(pattern, from);
        if (found < 0) break;
        score += 40;
        from = found + 1;
      }
    }
  };
  for (const row of modules) hunt(row);
  for (let x = 0; x < size; x++) hunt(modules.map((row) => row[x] ?? false));
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

function cloneMatrix(modules: boolean[][]): boolean[][] {
  return modules.map((row) => row.slice());
}

/**
 * Encode `text` as a QR symbol. `mask`, when passed, skips the penalty search
 * so tests can lock a known format-information string.
 */
export function encodeQr(text: string, mask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(byteModeDataCodewords(text, version), version);
  const base = drawFunctionPatterns(version);
  placeData(base.modules, base.fn, codewords);
  const chosen = mask ?? bestMask(base.modules, base.fn);
  const modules = cloneMatrix(base.modules);
  applyMask(modules, base.fn, chosen);
  drawFormat(modules, chosen);
  drawVersion(modules, version);
  return { size: modules.length, modules };
}

function bestMask(modules: boolean[][], fn: boolean[][]): number {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const copy = cloneMatrix(modules);
    applyMask(copy, fn, mask);
    drawFormat(copy, mask);
    const score = penalty(copy);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}
