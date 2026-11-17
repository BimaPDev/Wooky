const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cut `text` to at most `maxBytes` of UTF-8, ending with `marker` when something was dropped. */
export function truncateBytes(text: string, maxBytes: number, marker = "…"): string {
  if (encoder.encode(text).length <= maxBytes) return text;
  const room = maxBytes - encoder.encode(marker).length;
  const cut = decoder.decode(encoder.encode(text).slice(0, Math.max(0, room))).replace(/�+$/u, "");
  return cut + marker;
}

export function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}
