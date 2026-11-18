const PATH_TOKEN = "<path>";
const FRACTION = /^[\d.,]+\/[\d.,]+[.,;:]?$/;
const DANGEROUS_KEYS = /"(?:__proto__|constructor|prototype)"/;
const dangerous = new Set(["__proto__", "constructor", "prototype"]);

const looksLikePath = (token: string) =>
  token === "~" ||
  token.startsWith("~") ||
  token.toLowerCase().startsWith("file:") ||
  ((token.includes("/") || token.includes("\\")) && !FRACTION.test(token));

/**
 * A reader's note must not carry a path. Any token with a separator, `file:` URL or `~` is
 * replaced by "<path>", so only the first sentence survives, capped at 200 characters.
 */
export function sanitizeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const words: string[] = [];
  for (const token of note.trim().split(/\s+/)) {
    if (token === "") continue;
    if (!looksLikePath(token)) {
      words.push(token);
      continue;
    }
    const trail = /[.!?]+$/.exec(token)?.[0] ?? "";
    const last = words.length - 1;
    if (words[last] === PATH_TOKEN) words[last] = PATH_TOKEN + trail;
    else words.push(PATH_TOKEN + trail);
  }
  const joined = words.join(" ");
  const first = /^.*?[.!?](?=\s|$)/s.exec(joined)?.[0] ?? joined;
  const trimmed = first.trim().slice(0, 200);
  return trimmed === "" ? undefined : trimmed;
}

/** `JSON.parse` that drops `__proto__`, `constructor` and `prototype` keys at any depth. */
export function parseJsonSafely(text: string): unknown {
  if (!DANGEROUS_KEYS.test(text)) return JSON.parse(text);
  return JSON.parse(text, (key, value: unknown) => (dangerous.has(key) ? undefined : value));
}
