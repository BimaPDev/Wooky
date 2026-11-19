// age-allow-file color: assertions on generated theme CSS compare hex values.
import { AppearanceTheme, DeviceSettings, type RpcMethod, type ThemesPush } from "@age/contracts";
import { emptyReadModel } from "@age/domain";
import { describe, expect, it } from "vitest";
import { createRpcClient, type SocketHandlers, type SocketLike } from "../rpc/client.ts";
import {
  accentInkFor,
  buildAppearanceCss,
  contrastRatio,
  handleThemesPush,
  resolvePalette,
  resolveThemeVariant,
  stillSvgDataUrl,
} from "./appearance.ts";
import { setBackend } from "./backend.ts";
import { useStore } from "./store.ts";
import { BASE_PALETTES } from "./theme-data.ts";

const ui = { appearanceContrast: 100, glassOpacity: 80 };
const line = (css: string) => /--line: (#[0-9a-f]{6});/.exec(css)?.[1];
const theme = AppearanceTheme.parse({
  id: "neon",
  name: "Neon",
  appearance: "dark",
  canvas: "#101020",
  accent: "#ff00aa",
  colors: { text2: "#abcdef" },
  fonts: { ui: '"Geist", Inter', size: 15 },
  shape: { radius: 12, density: "compact" },
  css: ".chat-markdown { line-height: 1.7; }",
});

function toSvgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function fromSvgDataUrl(dataUrl: string): string {
  const b64 = dataUrl.slice("data:image/svg+xml;base64,".length);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

describe("resolveThemeVariant", () => {
  it("uses variant canvas, accent, colors and background when effective mode differs and variant exists", () => {
    const withVariants = AppearanceTheme.parse({
      ...theme,
      background: {
        image: "data:image/png;base64,iVBORw0KGgo=",
        dim: 40,
        panelBlur: 12,
      },
      variants: {
        light: {
          canvas: "#f4f3ef",
          accent: "#8a6a3b",
          colors: { text: "#1c1b18" },
          background: {
            image: "data:image/svg+xml;base64,PHN2Zy8+",
            dim: 20,
            panelBlur: 8,
          },
        },
      },
    });

    const lightResolved = resolveThemeVariant(withVariants, "light");
    expect(lightResolved.appearance).toBe("light");
    expect(lightResolved.canvas).toBe("#f4f3ef");
    expect(lightResolved.accent).toBe("#8a6a3b");
    expect(lightResolved.colors).toEqual({ text: "#1c1b18" });
    expect(lightResolved.background?.image).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(lightResolved.fonts).toEqual(withVariants.fonts);
    expect(lightResolved.shape).toEqual(withVariants.shape);
    expect(lightResolved.css).toBe(withVariants.css);

    const darkResolved = resolveThemeVariant(withVariants, "dark");
    expect(darkResolved).toBe(withVariants);
  });

  it("keeps top-level fields when effective mode differs and that variant is absent", () => {
    const resolved = resolveThemeVariant(theme, "light");
    expect(resolved).toBe(theme);
    expect(resolvePalette(theme, "light").bg0).toBe("#101020");
  });
});

describe("buildAppearanceCss", () => {
  it("outranks tokens.css in forced and system modes", () => {
    const css = buildAppearanceCss(theme, ui);
    expect(css).toContain('html:root[data-theme="dark"] {');
    expect(css).toContain("html:root:not([data-theme])");
    expect(css).toContain("--bg-0: #101020;");
    expect(css).toContain("--accent: #ff00aa;");
    expect(css).toContain("--text-2: #abcdef;");
  });

  it("keeps top-level palette in light mode when no light variant exists, and uses variants.light when present", () => {
    const withoutLightVariant = buildAppearanceCss(theme, ui);
    const lightFallback = withoutLightVariant.slice(
      withoutLightVariant.indexOf('html:root[data-theme="light"]'),
    );
    expect(lightFallback).toContain("--bg-0: #101020;");

    const withLightVariant = AppearanceTheme.parse({
      ...theme,
      variants: {
        light: {
          canvas: "#f4f3ef",
          accent: "#8a6a3b",
          colors: { text: "#1c1b18" },
        },
      },
    });
    const css = buildAppearanceCss(withLightVariant, ui);
    const lightSection = css.slice(css.indexOf('html:root[data-theme="light"]'));
    expect(lightSection).toContain("--bg-0: #f4f3ef;");
    expect(lightSection).toContain("--accent: #8a6a3b;");
    expect(lightSection).toContain("--text: #1c1b18;");
  });

  it("emits typography, radius and density", () => {
    const css = buildAppearanceCss(theme, ui);
    expect(css).toContain('--font-ui: "Geist", Inter, system-ui, sans-serif;');
    expect(css).toContain("--text-base: 15px;");
    expect(css).toContain("--radius: 12px;");
    expect(css).toContain("--space-4: 13px;");
  });

  it("applies contrast to hairlines but leaves the canvas alone", () => {
    const flat = buildAppearanceCss(null, ui);
    const sharp = buildAppearanceCss(null, { ...ui, appearanceContrast: 150 });
    expect(line(sharp)).not.toBe(line(flat));
    expect(sharp).toContain("--bg-0: #0a0a0a;");
  });

  it("emits frosted glass variables and @supports backdrop-filter without inlining wallpaper url in CSS", () => {
    const withImage = AppearanceTheme.parse({
      ...theme,
      background: {
        image: "data:image/png;base64,iVBORw0KGgo=",
        dim: 50,
        surfaceOpacity: 72,
        panelBlur: 16,
      },
    });
    const css = buildAppearanceCss(withImage, ui);
    expect(css).not.toContain('url("data:image/png;base64,iVBORw0KGgo=")');
    expect(css).toContain("--surface-opacity: 72%;");
    expect(css).toContain("--panel-blur: 16px;");
    expect(css).toContain(
      "color-mix(in srgb, var(--bg-0) var(--surface-opacity, 82%), transparent)",
    );
    expect(css).toContain("@supports (backdrop-filter: blur(1px))");
    expect(css).toContain("backdrop-filter: blur(var(--panel-blur, 0px));");
  });
});

describe("stillSvgDataUrl", () => {
  const sampleSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '<rect width="100" height="100" fill="#101020">',
    '<animate attributeName="opacity" values="0.5;1;0.5" dur="4s" repeatCount="indefinite"/>',
    '<set attributeName="fill" to="#202040" begin="1s"/>',
    "</rect>",
    '<g class="drifter">',
    '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="10s"/>',
    '<animateMotion path="M0,0 L10,10" dur="5s"><mpath href="#p"/></animateMotion>',
    '<circle cx="50" cy="50" r="20" fill="#ff00aa"/>',
    "</g>",
    "</svg>",
  ].join("");

  it("removes SMIL elements, appends the animation-disabling style, keeps other elements, and memoizes", () => {
    const input = toSvgDataUrl(sampleSvg);
    const output = stillSvgDataUrl(input);
    expect(output).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(stillSvgDataUrl(input)).toBe(output);

    const decoded = fromSvgDataUrl(output);
    expect(decoded).not.toContain("<animate");
    expect(decoded).not.toContain("<animateTransform");
    expect(decoded).not.toContain("<animateMotion");
    expect(decoded).not.toContain("<set");
    expect(decoded).toContain(
      "<style>*{animation:none!important;transition:none!important}</style>",
    );
    expect(decoded).toContain('<circle cx="50" cy="50" r="20" fill="#ff00aa"/>');
    expect(decoded).toContain('<rect width="100" height="100" fill="#101020">');
  });

  it("uses DOMParser('image/svg+xml') and XMLSerializer when available in the runtime", () => {
    let parseCalls = 0;
    const parseXml = (xml: string, mime: string) => {
      parseCalls += 1;
      expect(mime).toBe("image/svg+xml");
      const current = xml
        .replace(/<(animate|animateTransform|animateMotion|set)\b[^>]*\/\s*>/g, "")
        .replace(/<(animate|animateTransform|animateMotion|set)\b[^>]*>[\s\S]*?<\/\1\s*>/g, "");
      const appendedStyles: string[] = [];
      return {
        documentElement: {
          nodeName: "svg",
          appendChild: (node: { textContent: string }) => {
            appendedStyles.push(`<style>${node.textContent}</style>`);
          },
        },
        getElementsByTagName: (tag: string) => {
          if (tag === "parsererror") return [];
          return [{ remove: () => {} }];
        },
        createElementNS: (_ns: string, _tag: string) => ({ textContent: "" }),
        serialize: () => current.replace(/<\/svg>/, `${appendedStyles.join("")}</svg>`),
      };
    };

    const g = globalThis as Record<string, unknown>;
    const prevDomParser = g.DOMParser;
    const prevSerializer = g.XMLSerializer;
    g.DOMParser = class {
      parseFromString(xml: string, mime: string) {
        return parseXml(xml, mime);
      }
    };
    g.XMLSerializer = class {
      serializeToString(doc: { serialize: () => string }) {
        return doc.serialize();
      }
    };

    try {
      const uniqueInput = toSvgDataUrl(sampleSvg.replace('r="20"', 'r="25"'));
      const out = stillSvgDataUrl(uniqueInput);
      expect(parseCalls).toBe(1);
      const decoded = fromSvgDataUrl(out);
      expect(decoded).not.toContain("<animate");
      expect(decoded).toContain(
        "<style>*{animation:none!important;transition:none!important}</style>",
      );
      expect(decoded).toContain('r="25"');
    } finally {
      g.DOMParser = prevDomParser;
      g.XMLSerializer = prevSerializer;
    }
  });

  it("leaves non-SVG data URLs untouched", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(stillSvgDataUrl(png)).toBe(png);
  });
});

describe("themes push", () => {
  it("dispatches push === 'themes' from createRpcClient to onThemes", () => {
    let handlersRef: SocketHandlers = {
      open: () => {},
      message: () => {},
      close: () => {},
    };
    const fakeSocket: SocketLike = {
      readyState: 1,
      send: () => {},
      close: () => {},
    };
    const received: ThemesPush[] = [];
    const client = createRpcClient({
      url: "ws://test/ws",
      socketFactory: (_url, handlers) => {
        handlersRef = handlers;
        return fakeSocket;
      },
      getSeq: () => 0,
      onSnapshot: () => {},
      onEvent: () => {},
      onThemes: (push) => received.push(push),
    });

    handlersRef.message(
      JSON.stringify({
        push: "themes",
        activeThemeId: "neon",
        changedIds: ["neon"],
      }),
    );
    expect(received).toEqual([
      {
        push: "themes",
        activeThemeId: "neon",
        changedIds: ["neon"],
      },
    ]);
    client.close();
  });

  it("re-fetches themes.list, settings.get, and active theme when changed or switched", async () => {
    const calls: { method: RpcMethod; params: unknown }[] = [];
    let currentActiveId = "neon";
    useStore.setState({
      model: emptyReadModel(),
      deviceSettings: DeviceSettings.parse({ activeThemeId: "default" }),
      activeAppearance: null,
    });

    setBackend({
      call: (async (method: RpcMethod, params: unknown) => {
        calls.push({ method, params });
        if (method === "themes.list") {
          return {
            themesDir: "/tmp/themes",
            activeThemeId: currentActiveId,
            themes: [],
          };
        }
        if (method === "settings.get") {
          return DeviceSettings.parse({ activeThemeId: currentActiveId, colorMode: "dark" });
        }
        if (method === "themes.get") {
          return theme;
        }
        throw new Error(`unexpected ${method}`);
      }) as Parameters<typeof setBackend>[0]["call"],
    });

    await handleThemesPush({
      push: "themes",
      activeThemeId: "neon",
      changedIds: ["neon"],
    });
    expect(calls.map((c) => c.method)).toEqual(["themes.list", "settings.get", "themes.get"]);
    expect(useStore.getState().activeAppearance?.id).toBe("neon");

    calls.length = 0;
    await handleThemesPush({
      push: "themes",
      activeThemeId: "neon",
      changedIds: ["other"],
    });
    expect(calls.map((c) => c.method)).toEqual(["themes.list", "settings.get"]);

    calls.length = 0;
    await handleThemesPush({
      push: "themes",
      activeThemeId: "neon",
      changedIds: ["neon"],
    });
    expect(calls.map((c) => c.method)).toEqual(["themes.list", "settings.get", "themes.get"]);

    calls.length = 0;
    currentActiveId = "default";
    await handleThemesPush({
      push: "themes",
      activeThemeId: "default",
      changedIds: [],
    });
    expect(calls.map((c) => c.method)).toEqual(["themes.list", "settings.get"]);
    expect(useStore.getState().activeAppearance).toBeNull();
  });
});

describe("default dark palette contrast", () => {
  const dark = BASE_PALETTES.dark;

  it("meets WCAG AA for body text on layered surfaces", () => {
    expect(contrastRatio(dark.text, dark.bg0)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.text2, dark.bg1)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.text, dark.bg2)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("accent ink", () => {
  it("picks the ink with the higher contrast, including mid-tone accents", () => {
    for (const accent of ["#e0533d", "#3b82f6", "#22c55e", "#ffd60a", "#7c3aed", "#808080"]) {
      const ink = accentInkFor(accent);
      const other =
        ink === BASE_PALETTES.dark.accentInk
          ? BASE_PALETTES.light.accentInk
          : BASE_PALETTES.dark.accentInk;
      expect(contrastRatio(ink, accent)).toBeGreaterThanOrEqual(contrastRatio(other, accent));
      expect(contrastRatio(ink, accent)).toBeGreaterThan(3);
    }
  });
});

describe("theme contract", () => {
  it("rejects font lists that could break out of the declaration", () => {
    const bad = { ...theme, fonts: { ui: "x; } body { display: none" } };
    expect(AppearanceTheme.safeParse(bad).success).toBe(false);
  });

  it("rejects non-data background URLs", () => {
    const bad = { ...theme, background: { image: "https://example.com/a.png" } };
    expect(AppearanceTheme.safeParse(bad).success).toBe(false);
  });
});
