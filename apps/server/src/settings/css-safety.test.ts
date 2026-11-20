import { describe, expect, it } from "vitest";
import { assertSafeCss, sanitizeThemeCss } from "./css-safety.ts";

const svgDataUrl = (svg: string): string => `data:image/svg+xml,${encodeURIComponent(svg)}`;

describe("css-safety", () => {
  it("rejects escaped @import and url() in theme CSS", () => {
    expect(() => assertSafeCss('@i\\6dport "x.css";', "Theme css", "theme")).toThrow(/backslashes/);
    expect(() =>
      assertSafeCss(".a{fill:u\\72l(https://evil.example)}", "Theme css", "theme"),
    ).toThrow(/backslashes/);
    expect(sanitizeThemeCss('@i\\6dport "x.css";')).toBeNull();
  });

  it("keeps safe fixture CSS without backslashes", () => {
    const css = ".safe { color: var(--text); }";
    expect(sanitizeThemeCss(css)).toBe(css);
  });

  it("allows image data URLs in quoted and unquoted theme url()", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    for (const target of [png, `"${png}"`, `'${png}'`]) {
      const css = `.a{background:url(${target})}`;
      expect(sanitizeThemeCss(css)).toBe(css);
    }
    const svg = svgDataUrl(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`,
    );
    expect(sanitizeThemeCss(`.a{background:url("${svg}")}`)).toContain(svg);
  });

  it("rejects non-image data URLs in theme CSS", () => {
    expect(() =>
      assertSafeCss(
        '.a{background:url("data:text/html,<script>1</script>")}',
        "Theme css",
        "theme",
      ),
    ).toThrow(/allowed local targets/);
  });

  it("rejects unsafe SVG inside data URLs in theme CSS", () => {
    const svgUrl = (svg: string): string => `.a{background:url("${svgDataUrl(svg)}")}`;
    expect(() =>
      assertSafeCss(
        svgUrl(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
        "Theme css",
        "theme",
      ),
    ).toThrow(/disallowed tag <script>/);
    expect(() =>
      assertSafeCss(
        svgUrl(`<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x()"/></svg>`),
        "Theme css",
        "theme",
      ),
    ).toThrow(/event-handler attributes/);
    expect(() =>
      assertSafeCss(
        svgUrl(`<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>`),
        "Theme css",
        "theme",
      ),
    ).toThrow(/disallowed tag <foreignObject>/);
    expect(() =>
      assertSafeCss(
        svgUrl(
          `<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/a.svg#x"/></svg>`,
        ),
        "Theme css",
        "theme",
      ),
    ).toThrow(/href must be a local # fragment/);
  });

  it("scans a quoted data URL to its closing quote, not to the first )", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{clip-path:path('M0 0L1 1')}</style></svg>`;
    const css = `.a{background:url("${svgDataUrl(svg)}")}`;
    expect(sanitizeThemeCss(css)).toBe(css);
  });

  it("does not relax the svg profile for image data URLs", () => {
    expect(() =>
      assertSafeCss('.a{fill:url("data:image/png;base64,iVBORw0KGgo=")}', "Unsafe SVG", "svg"),
    ).toThrow(/allowed local targets/);
  });
});
