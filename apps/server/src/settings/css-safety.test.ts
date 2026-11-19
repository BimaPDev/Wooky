import { describe, expect, it } from "vitest";
import { assertSafeCss, sanitizeThemeCss } from "./css-safety.ts";

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
});
