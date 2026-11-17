import type { CSSProperties } from "react";

const COLORS = [
  "#9ca3af",
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#facc15",
  "#a3e635",
  "#4ade80",
  "#34d399",
  "#2dd4bf",
  "#22d3ee",
  "#38bdf8",
  "#60a5fa",
  "#818cf8",
  "#a78bfa",
  "#c084fc",
  "#e879f9",
  "#f472b6",
  "#fb7185",
] as const;

/** T3-style letters: first glyph + last glyph of the first word (or next word). */
export function projectMonogramText(name: string): string {
  const words =
    name
      .normalize("NFKC")
      .trim()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

export function projectMonogramColor(name: string): string {
  const seed = name.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % COLORS.length;
  }
  return COLORS[index] ?? COLORS[0];
}

/** PNG data URL so Electron `setIcon` and the Windows titlebar can use it. */
export function projectMonogramIconDataUrl(name: string): string {
  const text = projectMonogramText(name);
  const color = projectMonogramColor(name);
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const radius = size * 0.25;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = withAlpha(color, 0.22);
  roundRect(ctx, 0, 0, size, size, radius);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(size * 0.42)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + size * 0.03);
  return canvas.toDataURL("image/png");
}

function withAlpha(hex: string, alpha: number): string {
  const raw = hex.replace("#", "");
  const n = Number.parseInt(
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw,
    16,
  );
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function ProjectMonogram({
  name,
  className = "project-monogram",
}: {
  name: string;
  className?: string;
}) {
  const color = projectMonogramColor(name);
  const style = {
    "--project-monogram": color,
  } as CSSProperties;
  return (
    <span className={className} style={style} aria-hidden="true">
      {projectMonogramText(name)}
    </span>
  );
}
