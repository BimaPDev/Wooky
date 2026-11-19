import { describe, expect, it } from "vitest";
import {
  WALLPAPER_SCENES,
  assertSafeSvg,
  buildWallpaperScenes,
  mulberry32,
  toDataUrl,
} from "./scenes.ts";

const MAX_SVG_BYTES = 150 * 1024;

/**
 * Lightweight well-formed XML validator without external dependencies:
 * checks balanced tags, valid attribute quoting, no duplicate attributes,
 * and no unescaped `<` or `&` in text or attribute values.
 */
function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  let i = 0;
  let rootCount = 0;

  const checkEntities = (segment: string, context: string) => {
    for (let k = 0; k < segment.length; k += 1) {
      if (segment[k] === "&") {
        const rest = segment.slice(k);
        if (!/^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/.test(rest)) {
          throw new Error(`Unescaped '&' in ${context}: ${rest.slice(0, 20)}`);
        }
      }
    }
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      const trailing = xml.slice(i);
      if (trailing.trim().length > 0) {
        throw new Error(`Unexpected text outside root element: ${trailing.slice(0, 30)}`);
      }
      break;
    }

    const textBefore = xml.slice(i, lt);
    if (textBefore.length > 0) {
      if (stack.length === 0 && textBefore.trim().length > 0) {
        throw new Error(`Text before root element: ${textBefore.slice(0, 30)}`);
      }
      checkEntities(textBefore, "text node");
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("Unclosed XML comment");
      i = end + 3;
      continue;
    }

    if (xml.startsWith("</", lt)) {
      const gt = xml.indexOf(">", lt + 2);
      if (gt === -1) throw new Error("Unclosed closing tag");
      const tagName = xml.slice(lt + 2, gt).trim();
      const expected = stack.pop();
      if (expected !== tagName) {
        throw new Error(`Mismatched closing tag </${tagName}>, expected </${expected ?? "EOF"}>`);
      }
      i = gt + 1;
      continue;
    }

    // Opening or self-closing tag
    let pos = lt + 1;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9:._-]*/.exec(xml.slice(pos));
    if (!nameMatch) {
      throw new Error(`Invalid tag name near: ${xml.slice(lt, lt + 30)}`);
    }
    const tagName = nameMatch[0];
    pos += tagName.length;

    const seenAttrs = new Set<string>();
    let selfClosing = false;

    while (pos < xml.length) {
      while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos += 1;
      if (xml.startsWith("/>", pos)) {
        selfClosing = true;
        pos += 2;
        break;
      }
      if (xml[pos] === ">") {
        pos += 1;
        break;
      }

      const attrMatch = /^([A-Za-z_][A-Za-z0-9:._-]*)\s*=\s*(["'])/.exec(xml.slice(pos));
      if (!attrMatch) {
        throw new Error(`Malformed attribute in <${tagName}> near: ${xml.slice(pos, pos + 30)}`);
      }
      const attrName = attrMatch[1] ?? "";
      const quote = attrMatch[2] ?? '"';
      if (seenAttrs.has(attrName)) {
        throw new Error(`Duplicate attribute "${attrName}" on <${tagName}>`);
      }
      seenAttrs.add(attrName);

      pos += attrMatch[0].length;
      const closeQuote = xml.indexOf(quote, pos);
      if (closeQuote === -1) {
        throw new Error(`Unclosed attribute "${attrName}" on <${tagName}>`);
      }
      const attrVal = xml.slice(pos, closeQuote);
      if (attrVal.includes("<")) {
        throw new Error(`Unescaped '<' in attribute "${attrName}" on <${tagName}>`);
      }
      checkEntities(attrVal, `attribute ${attrName}`);
      pos = closeQuote + 1;
    }

    if (stack.length === 0) {
      rootCount += 1;
      if (rootCount > 1) throw new Error("Multiple root elements");
    }
    if (!selfClosing) {
      stack.push(tagName);
    }
    i = pos;
  }

  if (rootCount !== 1) {
    throw new Error(`Expected 1 root element, found ${rootCount}`);
  }
  if (stack.length > 0) {
    throw new Error(`Unclosed tags remaining: ${stack.join(", ")}`);
  }
}

describe("wallpaper scenes", () => {
  it("exports six original scenes covering dark and light tones", () => {
    expect(WALLPAPER_SCENES).toHaveLength(6);
    const ids = new Set(WALLPAPER_SCENES.map((s) => s.id));
    expect(ids.size).toBe(6);
    expect(WALLPAPER_SCENES.some((s) => s.tone === "dark")).toBe(true);
    expect(WALLPAPER_SCENES.some((s) => s.tone === "light")).toBe(true);
  });

  it("is deterministic across repeated procedural builds", () => {
    const first = mulberry32(12345);
    const second = mulberry32(12345);
    expect(Array.from({ length: 10 }, () => first())).toEqual(
      Array.from({ length: 10 }, () => second()),
    );

    const rebuilt = buildWallpaperScenes();
    expect(rebuilt).toEqual(WALLPAPER_SCENES);
  });

  it("satisfies SVG structure, size, motion, and safety requirements for every scene", () => {
    for (const scene of WALLPAPER_SCENES) {
      expect(
        scene.svg.startsWith(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1200" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">',
        ),
      ).toBe(true);
      expect(scene.svg).toContain("ui-monospace, SFMono-Regular, Menlo, monospace");
      expect(scene.svg).toContain("<text ");
      expect(scene.svg).toContain(
        "@media (prefers-reduced-motion: reduce){*{animation:none!important}}",
      );
      expect(scene.svg).toContain(`<rect width="1920" height="1200" fill="${scene.canvas}" />`);

      const byteLength = Buffer.byteLength(scene.svg, "utf8");
      expect(byteLength).toBeGreaterThan(1024);
      expect(byteLength).toBeLessThan(MAX_SVG_BYTES);

      assertSafeSvg(scene.svg);
      assertWellFormedXml(scene.svg);

      // Verify @keyframes only animate transform and opacity, and periods are 4-30s
      const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(scene.svg);
      expect(styleMatch).not.toBeNull();
      const css = styleMatch?.[1] ?? "";

      for (const kf of css.matchAll(/@keyframes\s+[^{]+\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
        const body = kf[1] ?? "";
        for (const block of body.matchAll(/\{([^{}]*)\}/g)) {
          const props = (block[1] ?? "")
            .split(";")
            .map((decl) => decl.trim())
            .filter(Boolean)
            .map((decl) => decl.split(":")[0]?.trim());
          for (const prop of props) {
            expect(["transform", "opacity"]).toContain(prop);
          }
        }
      }

      for (const dur of css.matchAll(/animation:[^;}]*?\b(\d+(?:\.\d+)?)s\b/g)) {
        const seconds = Number(dur[1]);
        expect(seconds).toBeGreaterThanOrEqual(4);
        expect(seconds).toBeLessThanOrEqual(30);
      }
    }
  });

  it("encodes SVG cleanly with toDataUrl", () => {
    for (const scene of WALLPAPER_SCENES) {
      const url = toDataUrl(scene.svg);
      expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
      const decoded = Buffer.from(
        url.slice("data:image/svg+xml;base64,".length),
        "base64",
      ).toString("utf8");
      expect(decoded).toBe(scene.svg);
    }
  });

  it("allows filter primitives used by imported glyph wallpapers but not feImage", () => {
    const filter = (body: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f">${body}</filter><rect filter="url(#f)"/></svg>`;
    expect(() =>
      assertSafeSvg(
        filter(
          '<feMorphology radius="1"/><feComponentTransfer><feFuncA type="table" tableValues="0 1"/></feComponentTransfer>',
        ),
      ),
    ).not.toThrow();
    expect(() => assertSafeSvg(filter('<feImage href="https://evil.example/x.png"/>'))).toThrow(
      /feimage/i,
    );
  });

  it("rejects unsafe SVG payloads in assertSafeSvg", () => {
    const unsafeSamples: Array<[string, string, RegExp]> = [
      [
        "<script>",
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        /disallowed tag/i,
      ],
      [
        "<SCRIPT> uppercase",
        '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>1</SCRIPT></svg>',
        /disallowed tag/i,
      ],
      [
        "onload=",
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
        /event-handler/,
      ],
      [
        "slash-separated on*",
        '<svg xmlns="http://www.w3.org/2000/svg"><g/onclick=alert(1)/></svg>',
        /event-handler/,
      ],
      [
        "<foreignObject>",
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>',
        /disallowed tag/i,
      ],
      [
        'href="https://..."',
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
        /href must be a local/,
      ],
      [
        'xlink:href="https://..."',
        '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.example/x.svg#a"/></svg>',
        /href must be a local/,
      ],
      [
        "javascript: href",
        '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>',
        /disallowed tag/i,
      ],
      [
        "@import",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.example/a.css";</style></svg>',
        /@import/,
      ],
      [
        "external url()",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:url(https://evil.example/a)}</style></svg>',
        /url\(\) may only/,
      ],
      [
        "animate href",
        '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" to="https://evil.example"/></svg>',
        /SMIL must not animate href/,
      ],
      [
        "iframe srcdoc",
        '<svg xmlns="http://www.w3.org/2000/svg"><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/></svg>',
        /disallowed tag/,
      ],
      [
        "CSS @import escape",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@im\\70 ort "x.css";</style></svg>',
        /backslashes/,
      ],
      [
        "numeric reference in attribute",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#114;l(https://evil.example/x)"/></svg>',
        /numeric character references/,
      ],
      [
        "numeric reference in style",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:u&#x72;l(https://evil.example/x)}</style></svg>',
        /numeric character references/,
      ],
      [
        "CSS url escape",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:u\\72l(https://evil.example)}</style></svg>',
        /backslashes/,
      ],
      [
        "image-set",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{background:image-set("https://evil.example/x" 1x)}</style></svg>',
        /image-set/,
      ],
      [
        "DOCTYPE entity",
        '<!DOCTYPE svg [<!ENTITY x "bad">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
        /DOCTYPE/,
      ],
      ["ev:onload", '<svg xmlns="http://www.w3.org/2000/svg" ev:onload="alert(1)"></svg>', /on\*/],
      [
        "on:load namespaced",
        '<svg xmlns="http://www.w3.org/2000/svg" on:load="alert(1)"></svg>',
        /event-handler/,
      ],
      [
        "on:click unquoted",
        '<svg xmlns="http://www.w3.org/2000/svg" on:click=alert(1)></svg>',
        /event-handler/,
      ],
      [
        "fill url https",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "stroke url https",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect stroke="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "mask url https",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect mask="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "filter attr url https",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect filter="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "clip-path url https",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect clip-path="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "marker-end url https",
        '<svg xmlns="http://www.w3.org/2000/svg"><path marker-end="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "url javascript",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(javascript:alert(1))"/></svg>',
        /javascript/i,
      ],
      [
        "url data",
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(data:text/html,x)"/></svg>',
        /url\(\)/,
      ],
      [
        "xml:base",
        '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://evil.example/"></svg>',
        /base URL/,
      ],
      [
        "base attribute",
        '<svg xmlns="http://www.w3.org/2000/svg" base="https://evil.example/"></svg>',
        /base URL/,
      ],
      [
        "set smil clip-path",
        '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="clip-path" to="url(https://evil.example)"/></svg>',
        /url\(\)/,
      ],
      [
        "animate smil values url",
        '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="fill" values="url(https://evil.example);red"/></svg>',
        /url\(\)/,
      ],
      [
        "fake style close",
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{content:"</style"} .b{}</style></svg>',
        /`<` is not allowed/,
      ],
    ];

    for (const [label, sample, pattern] of unsafeSamples) {
      expect(() => assertSafeSvg(sample), `expected ${label} to throw`).toThrow(pattern);
    }

    expect(() =>
      assertSafeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="ok"/></defs><use href="#ok" fill="url(#ok)"/></svg>',
      ),
    ).not.toThrow();

    expect(() =>
      assertSafeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="20" fill="#7aa2f7"><animate attributeName="opacity" values="1;0.3;1" dur="4s" repeatCount="indefinite"/></circle></svg>',
      ),
    ).not.toThrow();
  });
});
