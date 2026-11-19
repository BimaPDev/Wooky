import { createHash } from "node:crypto";

const MAX_ID_CHARS = 128;

/** Timeline ids are capped at 128 characters. A hash keeps long provider ids distinct. */
export function fitId(raw: string, fallback = "item"): string {
  const trimmed = raw.trim();
  const base = trimmed.length > 0 ? trimmed : fallback;
  if (base.length <= MAX_ID_CHARS) return base;
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 12);
  return `${base.slice(0, MAX_ID_CHARS - hash.length - 1)}:${hash}`;
}

export function truncateBytes(text: string, maxBytes: number, marker = "…"): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  const room = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let sliced = buffer.subarray(0, room).toString("utf8");
  if (sliced.endsWith("\uFFFD")) sliced = sliced.slice(0, -1);
  return `${sliced}${marker}`;
}

export function previewValue(value: unknown, maxChars = 500): string {
  let text = "";
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

export function truncateTitle(raw: string, fallback = "Tool"): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  const text = compact.length > 0 ? compact : fallback;
  if (text.length <= 120) return text;
  return `${text.slice(0, 119)}…`;
}
