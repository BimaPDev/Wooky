const ALLOWED_TAGS = new Set(
  [
    "svg",
    "g",
    "defs",
    "use",
    "symbol",
    "text",
    "tspan",
    "rect",
    "path",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "filter",
    "feGaussianBlur",
    "feColorMatrix",
    "feOffset",
    "feMerge",
    "feMergeNode",
    "feFlood",
    "feComposite",
    "feBlend",
    "title",
    "desc",
    "style",
    "animate",
    "animateTransform",
    "animateMotion",
    "set",
    "mpath",
  ].map((tag) => tag.toLowerCase()),
);

const SMIL_TAGS = new Set(
  ["animate", "animatetransform", "animatemotion", "set"].map((t) => t.toLowerCase()),
);

const FRAGMENT_HREF_RE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

type ParsedAttr = { name: string; value: string };

function skipWs(s: string, i: number): number {
  while (i < s.length && /[\t\n\r\f ]/.test(s.charAt(i))) i += 1;
  return i;
}

function tagLocalName(name: string): string {
  const parts = name.split(":");
  return parts[parts.length - 1] ?? name;
}

function attrLocalName(name: string): string {
  return tagLocalName(name);
}

function assertAllowedTagName(name: string): void {
  const local = tagLocalName(name).toLowerCase();
  if (!ALLOWED_TAGS.has(local)) {
    throw new Error(`Unsafe SVG: disallowed tag <${name}>.`);
  }
}

function scanForbiddenMarkup(svg: string): void {
  if (svg.includes("\\")) {
    throw new Error("Unsafe SVG: backslashes are not allowed.");
  }
  const lower = svg.toLowerCase();
  if (lower.includes("<!doctype")) {
    throw new Error("Unsafe SVG: DOCTYPE is not allowed.");
  }
  if (lower.includes("<!entity")) {
    throw new Error("Unsafe SVG: ENTITY declarations are not allowed.");
  }
  if (lower.includes("<![cdata[")) {
    throw new Error("Unsafe SVG: CDATA sections are not allowed.");
  }
}

function assertLeadingXmlProlog(svg: string, start: number): number {
  let i = skipWs(svg, start);
  if (!svg.startsWith("<?", i)) return i;
  const end = svg.indexOf("?>", i);
  if (end === -1) throw new Error("Unsafe SVG: unterminated processing instruction.");
  const pi = svg.slice(i, end + 2);
  if (!/^<\?xml\s/i.test(pi)) {
    throw new Error("Unsafe SVG: only an XML declaration is allowed at the top.");
  }
  i = end + 2;
  return skipWs(svg, i);
}

function assertNoProcessingInstructions(svg: string, after: number): void {
  if (svg.indexOf("<?", after) !== -1) {
    throw new Error("Unsafe SVG: processing instructions are not allowed.");
  }
}

function parseName(s: string, i: number): { name: string; end: number } | null {
  if (i >= s.length || !/[:A-Za-z_]/.test(s.charAt(i))) return null;
  const start = i;
  i += 1;
  while (i < s.length && /[:A-Za-z0-9_.-]/.test(s.charAt(i))) i += 1;
  return { name: s.slice(start, i), end: i };
}

function parseOpenTag(
  s: string,
  start: number,
): {
  name: string;
  attrs: ParsedAttr[];
  selfClose: boolean;
  end: number;
} {
  let i = start + 1;
  const namePart = parseName(s, i);
  if (!namePart) throw new Error("Unsafe SVG: malformed tag.");
  i = skipWs(s, namePart.end);
  const attrs: ParsedAttr[] = [];
  while (i < s.length && s[i] !== ">" && !(s[i] === "/" && s[i + 1] === ">")) {
    const attrName = parseName(s, i);
    if (!attrName) {
      i += 1;
      continue;
    }
    i = skipWs(s, attrName.end);
    let value = "";
    if (s[i] === "=") {
      i += 1;
      i = skipWs(s, i);
      if (s[i] === '"' || s[i] === "'") {
        const quote = s.charAt(i);
        i += 1;
        const valueStart = i;
        while (i < s.length && s.charAt(i) !== quote) i += 1;
        value = s.slice(valueStart, i);
        if (s.charAt(i) === quote) i += 1;
      } else {
        const valueStart = i;
        while (i < s.length && !/[\t\n\r\f />]/.test(s.charAt(i))) i += 1;
        value = s.slice(valueStart, i);
      }
    }
    attrs.push({ name: attrName.name, value });
    i = skipWs(s, i);
  }
  const selfClose = s[i] === "/" && s[i + 1] === ">";
  if (selfClose) return { name: namePart.name, attrs, selfClose: true, end: i + 2 };
  if (s[i] !== ">") throw new Error("Unsafe SVG: malformed tag.");
  return { name: namePart.name, attrs, selfClose: false, end: i + 1 };
}

function parseCloseTag(s: string, start: number): { name: string; end: number } {
  let i = start + 2;
  const namePart = parseName(s, i);
  if (!namePart) throw new Error("Unsafe SVG: malformed closing tag.");
  i = skipWs(s, namePart.end);
  if (s[i] !== ">") throw new Error("Unsafe SVG: malformed closing tag.");
  return { name: namePart.name, end: i + 1 };
}

function assertSafeCss(css: string, context: string): void {
  const lower = css.toLowerCase();
  if (/@import\b/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain @import.`);
  }
  if (/@font-face\b/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain @font-face.`);
  }
  if (/\bimage-set\s*\(/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain image-set().`);
  }
  if (/\belement\s*\(/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain element().`);
  }
  if (/\bcross-fade\s*\(/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain cross-fade().`);
  }
  if (/\bexpression\s*\(/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain expression().`);
  }
  if (/javascript\s*:/.test(lower)) {
    throw new Error(`Unsafe SVG: ${context} must not contain javascript: URLs.`);
  }
  const urlRe = /\burl\s*\(/gi;
  for (const match of css.matchAll(urlRe)) {
    if (match.index === undefined) continue;
    const after = css.slice(match.index + match[0].length);
    if (!/^\s*(?:#[-A-Za-z0-9_.:]+|"#[-A-Za-z0-9_.:]+"|'#[-A-Za-z0-9_.:]+')/.test(after)) {
      throw new Error(`Unsafe SVG: ${context} url() may only reference local # fragments.`);
    }
  }
}

function assertSafeAttribute(tagName: string, attr: ParsedAttr): void {
  const local = attrLocalName(attr.name);
  const localLower = local.toLowerCase();
  if (localLower.startsWith("on")) {
    throw new Error("Unsafe SVG: event-handler attributes (on*) are not allowed.");
  }
  if (localLower === "href") {
    if (!FRAGMENT_HREF_RE.test(attr.value.trim())) {
      throw new Error(`Unsafe SVG: href must be a local # fragment, not "${attr.value.trim()}".`);
    }
  }
  if (localLower === "style" || attr.name.toLowerCase() === "style") {
    assertSafeCss(attr.value, "style attribute");
  }
  const tagLocal = tagLocalName(tagName).toLowerCase();
  if (SMIL_TAGS.has(tagLocal) && localLower === "attributename") {
    const target = attr.value.trim();
    if (/^(xlink:)?href$/i.test(target)) {
      throw new Error("Unsafe SVG: SMIL must not animate href.");
    }
    if (/^on/i.test(target)) {
      throw new Error("Unsafe SVG: SMIL must not animate event handlers.");
    }
    if (/^style$/i.test(target)) {
      throw new Error("Unsafe SVG: SMIL must not animate style.");
    }
  }
}

function readStyleContent(s: string, afterOpen: number): { content: string; end: number } {
  const closeRe = /<\/style\s*>/i;
  const rest = s.slice(afterOpen);
  const match = closeRe.exec(rest);
  if (!match) throw new Error("Unsafe SVG: unclosed <style> element.");
  return { content: rest.slice(0, match.index), end: afterOpen + match.index + match[0].length };
}

export function assertSafeSvg(svg: string): void {
  scanForbiddenMarkup(svg);
  let i = assertLeadingXmlProlog(svg, 0);
  assertNoProcessingInstructions(svg, i);

  while (i < svg.length) {
    if (svg[i] !== "<") {
      i += 1;
      continue;
    }

    if (svg.startsWith("</", i)) {
      const close = parseCloseTag(svg, i);
      assertAllowedTagName(close.name);
      i = close.end;
      continue;
    }

    if (svg.startsWith("<!", i)) {
      throw new Error("Unsafe SVG: markup declarations are not allowed.");
    }

    if (svg.startsWith("<?", i)) {
      throw new Error("Unsafe SVG: processing instructions are not allowed.");
    }

    const open = parseOpenTag(svg, i);
    assertAllowedTagName(open.name);
    for (const attr of open.attrs) assertSafeAttribute(open.name, attr);

    i = open.end;
    const tagLocal = tagLocalName(open.name).toLowerCase();
    if (!open.selfClose && tagLocal === "style") {
      const block = readStyleContent(svg, i);
      assertSafeCss(block.content, "<style> content");
      i = block.end;
    }
  }
}
