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
