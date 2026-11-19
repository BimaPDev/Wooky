import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppearanceTheme, type AppearanceTheme as Theme } from "@wooky/contracts";
import { ServiceError } from "../errors.ts";
import { tempDir } from "../testing.ts";
import { toDataUrl } from "./wallpapers/scenes.ts";
import { createThemeStore } from "./themes.ts";

const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#222"/></svg>`;
const evilScriptSvg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
const evilOnloadSvg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`;

function baseTheme(overrides: Partial<Theme> = {}): Theme {
  return AppearanceTheme.parse({
    version: 1,
    id: "custom-safe",
    name: "Custom",
    appearance: "dark",
    canvas: "#0c0c0c",
    accent: "#d7c9a7",
    colors: {},
    css: "",
    ...overrides,
  });
}

describe("createThemeStore put validation", () => {
  it("rejects @import in theme css", async () => {
    const store = createThemeStore(await tempDir("themes-put"));
    let error: unknown;
    try {
      store.put(
        baseTheme({ id: "evil-import", css: '@import url("https://evil.example/x.css");' }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("bad_request");
    expect((error as ServiceError).message).toMatch(/@import/);
  });

  it("rejects CSS escape sequences that smuggle url()", async () => {
    const store = createThemeStore(await tempDir("themes-put"));
    expect(() =>
      store.put(baseTheme({ id: "evil-escape", css: ".a{fill:u\\72l(https://evil.example)}" })),
    ).toThrow(/backslashes/);
  });

  it("rejects unsafe SVG wallpaper payloads", async () => {
    const store = createThemeStore(await tempDir("themes-put"));
    for (const [label, svg] of [
      ["script", evilScriptSvg],
      ["onload", evilOnloadSvg],
    ] as const) {
      expect(() =>
        store.put(
          baseTheme({
            id: `evil-svg-${label}`,
            background: { image: toDataUrl(svg) },
          }),
        ),
      ).toThrow(label === "script" ? /script/i : /onload|event|unsafe/i);
    }
  });

  it("accepts a safe SVG wallpaper", async () => {
    const store = createThemeStore(await tempDir("themes-put"));
    const saved = store.put(
      baseTheme({
        id: "wall-safe",
        background: { image: toDataUrl(safeSvg), fit: "cover" },
      }),
    );
    expect(saved.background?.image).toBe(toDataUrl(safeSvg));
    expect(store.get("wall-safe").id).toBe("wall-safe");
  });

  it("rejects an unsafe SVG in a variant background", async () => {
    const store = createThemeStore(await tempDir("themes-put"));
    expect(() =>
      store.put(
        baseTheme({
          id: "evil-variant",
          variants: {
            light: {
              canvas: "#fafaf8",
              accent: "#d7c9a7",
              colors: {},
              background: { image: toDataUrl(evilScriptSvg) },
            },
          },
        }),
      ),
    ).toThrow(/script/i);
  });
});

describe("createThemeStore disk themes", () => {
  it("skips invalid files in list, returns not_found on get, keeps serving", async () => {
    const home = await tempDir("themes-disk");
    const store = createThemeStore(home);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const good = baseTheme({ id: "good-on-disk", name: "Good" });
    await writeFile(join(home, "themes", "good-on-disk.json"), JSON.stringify(good), "utf8");

    const bad = baseTheme({ id: "bad-on-disk", css: '@import "https://evil.example/x.css";' });
    await writeFile(join(home, "themes", "bad-on-disk.json"), JSON.stringify(bad), "utf8");

    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ activeThemeId: "bad-on-disk" }, null, 2),
    );

    const { themes } = store.list();
    expect(themes.map((t) => t.id)).toContain("good-on-disk");
    expect(themes.map((t) => t.id)).not.toContain("bad-on-disk");

    expect(() => store.get("bad-on-disk")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/bad-on-disk\.json/));

    expect(store.get("good-on-disk").id).toBe("good-on-disk");
    warn.mockRestore();
  });
});
