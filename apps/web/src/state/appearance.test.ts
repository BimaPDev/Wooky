// age-allow-file color: assertions on generated theme CSS compare hex values.
import { AppearanceTheme, DeviceSettings, type RpcMethod, type ThemesPush } from "@wooky/contracts";
import { emptyReadModel } from "@wooky/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { createRpcClient, type SocketHandlers, type SocketLike } from "../rpc/client.ts";
import {
  accentInkFor,
  applyAppearanceTheme,
  buildAppearanceCss,
  contrastRatio,
  handleThemesPush,
  resolvePalette,
  resolveThemeVariant,
  STILL_IMAGE_CACHE_LIMIT,
  stillImageCache,
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

function decodeStillSvg(dataUrl: string | null): string {
  if (dataUrl === null) throw new Error("expected still svg data url");
  return fromSvgDataUrl(dataUrl);
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

  beforeEach(() => stillImageCache.clear());

  it("removes SMIL elements, appends the animation-disabling style, keeps other elements, and memoizes", () => {
    const input = toSvgDataUrl(sampleSvg);
    const output = stillSvgDataUrl(input);
    expect(output).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(output).not.toBe(input);
    expect(stillSvgDataUrl(input)).toBe(output);

    const decoded = decodeStillSvg(output);
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
      const decoded = decodeStillSvg(out);
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

  it("uses freezeSvgFallback when DOMParser fails to parse, and never returns the animated URL", () => {
    const g = globalThis as Record<string, unknown>;
    const prevDomParser = g.DOMParser;
    const prevSerializer = g.XMLSerializer;
    g.DOMParser = class {
      parseFromString() {
        return {
          documentElement: { nodeName: "parsererror", appendChild: () => {} },
          getElementsByTagName: (tag: string) => (tag === "parsererror" ? [{}] : []),
          createElementNS: () => ({ textContent: "" }),
        };
      }
    };
    g.XMLSerializer = class {
      serializeToString() {
        throw new Error("should not serialize a parsererror document");
      }
    };

    try {
      const input = toSvgDataUrl(sampleSvg.replace('r="20"', 'r="21"'));
      const out = stillSvgDataUrl(input);
      expect(out).not.toBe(input);
      const decoded = decodeStillSvg(out);
      expect(decoded).not.toContain("<animate");
      expect(decoded).not.toContain("<animateTransform");
      expect(decoded).toContain(
        "<style>*{animation:none!important;transition:none!important}</style>",
      );
      expect(decoded).toContain('r="21"');
    } finally {
      g.DOMParser = prevDomParser;
      g.XMLSerializer = prevSerializer;
    }
  });

  it("returns null when freezing fails, never the animated original", () => {
    const garbage = toSvgDataUrl("not an svg");
    expect(stillSvgDataUrl(garbage)).toBeNull();
    expect(stillSvgDataUrl("data:image/svg+xml;base64,!!!!")).toBeNull();
  });

  it("leaves non-SVG data URLs untouched", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(stillSvgDataUrl(png)).toBe(png);
  });
});

describe("still image LRU", () => {
  beforeEach(() => stillImageCache.clear());

  it(`evicts the least-recent entry once it exceeds ${STILL_IMAGE_CACHE_LIMIT}`, () => {
    expect(STILL_IMAGE_CACHE_LIMIT).toBe(8);
    for (let i = 0; i < STILL_IMAGE_CACHE_LIMIT; i += 1) {
      stillImageCache.set(`k${i}`, `v${i}`);
    }
    expect(stillImageCache.get("k0")).toBe("v0");
    stillImageCache.set("k8", "v8");
    expect(stillImageCache.get("k0")).toBe("v0");
    expect(stillImageCache.get("k1")).toBeUndefined();
    expect(stillImageCache.get("k8")).toBe("v8");
    stillImageCache.set("k9", null);
    expect(stillImageCache.get("k2")).toBeUndefined();
    expect(stillImageCache.get("k9")).toBeNull();
    expect(stillImageCache.size).toBe(STILL_IMAGE_CACHE_LIMIT);
  });

  it("shares the LRU between SVG stills and raster stills", () => {
    const urls = Array.from({ length: STILL_IMAGE_CACHE_LIMIT }, (_, i) =>
      toSvgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg"><rect id="n${i}"/></svg>`),
    );
    const stills = urls.map((url) => stillSvgDataUrl(url));
    expect(stills.every(Boolean)).toBe(true);
    const rasterKey = "data:image/gif;base64,R0lGOD";
    stillImageCache.set(rasterKey, "data:image/png;base64,xx");
    const oldest = urls.at(0);
    const next = urls.at(1);
    if (oldest === undefined || next === undefined) throw new Error("expected svg urls");
    expect(stillImageCache.get(oldest)).toBeUndefined();
    expect(stillImageCache.get(next)).toBe(stills.at(1));
    expect(stillImageCache.get(rasterKey)).toBe("data:image/png;base64,xx");
    expect(stillImageCache.size).toBe(STILL_IMAGE_CACHE_LIMIT);
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

  it("drops a stale push when a later push started, even if the first resolves last", async () => {
    const staleTheme = AppearanceTheme.parse({ ...theme, id: "stale", name: "Stale" });
    const freshTheme = AppearanceTheme.parse({ ...theme, id: "fresh", name: "Fresh" });
    const settingsGates: Array<{
      promise: Promise<DeviceSettings>;
      resolve: (value: DeviceSettings) => void;
    }> = [];

    useStore.setState({
      model: emptyReadModel(),
      deviceSettings: DeviceSettings.parse({ activeThemeId: "default" }),
      activeAppearance: null,
      previewAppearance: null,
    });

    setBackend({
      call: (async (method: RpcMethod, params: unknown) => {
        if (method === "themes.list") {
          return { themesDir: "/tmp/themes", activeThemeId: "default", themes: [] };
        }
        if (method === "settings.get") {
          let resolve!: (value: DeviceSettings) => void;
          const promise = new Promise<DeviceSettings>((r) => {
            resolve = r;
          });
          settingsGates.push({ promise, resolve });
          return promise;
        }
        if (method === "themes.get") {
          const id = (params as { id: string }).id;
          if (id === "stale") return staleTheme;
          if (id === "fresh") return freshTheme;
          throw new Error(`unexpected theme ${id}`);
        }
        throw new Error(`unexpected ${method}`);
      }) as Parameters<typeof setBackend>[0]["call"],
    });

    const first = handleThemesPush({
      push: "themes",
      activeThemeId: "stale",
      changedIds: ["stale"],
    });
    const second = handleThemesPush({
      push: "themes",
      activeThemeId: "fresh",
      changedIds: ["fresh"],
    });

    expect(settingsGates).toHaveLength(2);
    settingsGates[1]?.resolve(DeviceSettings.parse({ activeThemeId: "fresh", colorMode: "dark" }));
    await second;
    expect(useStore.getState().activeAppearance?.id).toBe("fresh");

    settingsGates[0]?.resolve(DeviceSettings.parse({ activeThemeId: "stale", colorMode: "dark" }));
    await first;
    expect(useStore.getState().activeAppearance?.id).toBe("fresh");
  });

  it("updates the stored active theme on push without clearing an open editor preview", async () => {
    const draft = AppearanceTheme.parse({ ...theme, name: "Draft", canvas: "#222233" });
    const pushed = AppearanceTheme.parse({ ...theme, id: "paper", name: "Paper" });

    useStore.setState({
      model: emptyReadModel(),
      deviceSettings: DeviceSettings.parse({ activeThemeId: "neon" }),
      activeAppearance: theme,
      previewAppearance: draft,
    });

    const requested: string[] = [];
    setBackend({
      call: (async (method: RpcMethod, params: unknown) => {
        if (method === "themes.list") {
          return { themesDir: "/tmp/themes", activeThemeId: "paper", themes: [] };
        }
        if (method === "settings.get") {
          return DeviceSettings.parse({ activeThemeId: "paper", colorMode: "dark" });
        }
        if (method === "themes.get") {
          requested.push((params as { id: string }).id);
          return pushed;
        }
        throw new Error(`unexpected ${method}`);
      }) as Parameters<typeof setBackend>[0]["call"],
    });

    await handleThemesPush({
      push: "themes",
      activeThemeId: "paper",
      changedIds: ["paper"],
    });

    expect(requested).toEqual(["paper"]);
    expect(useStore.getState().previewAppearance).toBe(draft);
    expect(useStore.getState().activeAppearance).toEqual(pushed);

    applyAppearanceTheme(theme);
    expect(useStore.getState().previewAppearance).toBe(draft);
    expect(useStore.getState().activeAppearance).toEqual(theme);
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
