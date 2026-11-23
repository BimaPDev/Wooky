/**
 * Code points that draw nothing or change nothing on screen but are still read by a model: control
 * and format characters (zero-width, bidi, soft hyphen, word joiner, tag characters), private-use and
 * unassigned code points, lone surrogates, variation selectors, the combining grapheme joiner and
 * the Mongolian vowel separator. Text that carries them is a place to hide instructions.
 * Line and paragraph separators go with them.
 */
export const INVISIBLE = new RegExp(
  String.raw`[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u{2028}\u{2029}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{34F}\u{180E}]`,
  "u",
);
export const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "gu");

/** Look-alikes of `<` and `>` that NFKC leaves alone. */
const OPENING = /[\u2039\u2329\u3008\u27e8\u02c2\u1438]/g;
const CLOSING = /[\u203a\u232a\u3009\u27e9\u02c3\u1433]/g;

/** Removes control and invisible characters, keeping newlines and tabs when `multiline` is true. */
export function stripInvisible(text: string, multiline = false): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_ALL, (char) =>
      char === "\n" || char === "\t" ? (multiline ? char : " ") : "",
    );
}

/**
 * Makes untrusted text safe to put inside an XML-like fence: invisible and control characters are
 * dropped, Unicode is folded (NFKC, then look-alike angle brackets), and `&`, `<` and `>` are
 * escaped, so an escape Wooky wrote can be told from one the content forged.
 */
export function sanitizeText(text: string, multiline = false): string {
  return stripInvisible(stripInvisible(text, multiline).normalize("NFKC"), multiline)
    .replace(OPENING, "<")
    .replace(CLOSING, ">")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
