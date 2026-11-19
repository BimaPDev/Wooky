import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppearanceTheme,
  AppearanceThemeSummary,
  DeviceSettings,
  type AppearanceTheme as Theme,
  type DeviceSettings as Settings,
} from "@age/contracts";
import { ServiceError } from "../errors.ts";
import { getBuiltinWallpaperThemes } from "./builtin-wallpapers.ts";
import { importTheme as parseImport } from "./theme-import.ts";

const SETTINGS_FILE = "settings.json";
const THEMES_DIR = "themes";

const BUILTIN: Theme[] = [
  {
    version: 1,
    id: "default",
    name: "Default",
    appearance: "dark",
    canvas: "#0d0d0c",
    accent: "#d7c9a7",
    colors: {},
    css: "",
    builtin: true,
  },
  {
    version: 1,
    id: "abyss",
    name: "Abyss",
    appearance: "dark",
    canvas: "#0b0a12",
    accent: "#a78bfa",
    colors: {
      bg0: "#0b0a12",
      bg1: "#12111c",
      bg2: "#1a1828",
      bg3: "#242038",
      bgHover: "#2c2742",
      bgActive: "#352f4f",
      line: "#2a2540",
      lineStrong: "#3d3658",
      text: "#f3f0ff",
      text2: "#c4bdd9",
      text3: "#8f87ab",
      text4: "#6a6285",
      accent: "#a78bfa",
      accentInk: "#160f28",
      focus: "#c4b5fd",
      amber: "#f0b45a",
      amberBg: "#2a2114",
      red: "#f07178",
      redBg: "#2c1716",
      green: "#7ddea0",
    },
    css: "",
    builtin: true,
  },
  {
    version: 1,
    id: "grove",
    name: "Grove",
    appearance: "dark",
    canvas: "#0c100e",
    accent: "#8fbc8f",
    colors: {
      accent: "#8fbc8f",
      accentInk: "#0f1a12",
      focus: "#a8d5a8",
      green: "#8fbc8f",
    },
    css: "",
    builtin: true,
  },
  {
    version: 1,
    id: "ember",
    name: "Ember",
    appearance: "dark",
    canvas: "#120e0c",
    accent: "#e2a54a",
    colors: {
      accent: "#e2a54a",
      accentInk: "#1a1208",
      focus: "#f0c27a",
      amber: "#e2a54a",
    },
    css: "",
    builtin: true,
  },
];

function allBuiltins(): Theme[] {
  return [...BUILTIN, ...getBuiltinWallpaperThemes()];
}

function toSummary(theme: Theme, builtin: boolean) {
  const modes: Array<"dark" | "light"> = [theme.appearance];
  const other = theme.appearance === "dark" ? "light" : "dark";
  if (theme.variants?.[other]) modes.push(other);
  const layers = [
    theme.background,
    theme.variants?.dark?.background,
    theme.variants?.light?.background,
  ];
  return AppearanceThemeSummary.parse({
    id: theme.id,
    name: theme.name,
    appearance: theme.appearance,
    canvas: theme.canvas,
    accent: theme.accent,
    builtin,
    hasCss: theme.css.length > 0,
    hasWallpaper: layers.some((layer) => layer?.image !== undefined),
    animated: layers.some((layer) => layer?.animated === true),
    modes,
  });
}

export function createThemeStore(home: string) {
  const themesDir = join(home, THEMES_DIR);
  const settingsPath = join(home, SETTINGS_FILE);
  mkdirSync(themesDir, { recursive: true });

  function readSettings(): Settings {
    try {
      return DeviceSettings.parse(JSON.parse(readFileSync(settingsPath, "utf8")));
    } catch {
      return DeviceSettings.parse({});
    }
  }

  function writeSettings(settings: Settings): Settings {
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }

  function customPath(id: string): string {
    return join(themesDir, `${id}.json`);
  }

  function readCustom(id: string): Theme | null {
    try {
      const raw = JSON.parse(readFileSync(customPath(id), "utf8"));
      const theme = AppearanceTheme.parse({ ...raw, id, builtin: false });
      return theme;
    } catch {
      return null;
    }
  }

  function list(): {
    themesDir: string;
    activeThemeId: string;
    themes: ReturnType<typeof AppearanceThemeSummary.parse>[];
  } {
    const settings = readSettings();
    const seen = new Set<string>();
    const themes: ReturnType<typeof AppearanceThemeSummary.parse>[] = [];
    for (const theme of allBuiltins()) {
      seen.add(theme.id);
      themes.push(toSummary(theme, true));
    }
    for (const name of readdirSync(themesDir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (seen.has(id)) continue;
      const theme = readCustom(id);
      if (!theme) continue;
      seen.add(id);
      themes.push(toSummary(theme, false));
    }
    return { themesDir, activeThemeId: settings.activeThemeId, themes };
  }

  function get(id: string): Theme {
    const builtin = allBuiltins().find((theme) => theme.id === id);
    if (builtin) return builtin;
    const custom = readCustom(id);
    if (custom) return custom;
    throw new ServiceError("not_found", `Theme "${id}" was not found.`);
  }

  function put(input: Theme): Theme {
    if (allBuiltins().some((theme) => theme.id === input.id))
      throw new ServiceError("conflict", `Built-in theme "${input.id}" cannot be overwritten.`);
    const theme = AppearanceTheme.parse({ ...input, builtin: false });
    writeFileSync(customPath(theme.id), `${JSON.stringify(theme, null, 2)}\n`, "utf8");
    return theme;
  }

  function remove(id: string): { deleted: boolean } {
    if (allBuiltins().some((theme) => theme.id === id))
      throw new ServiceError("conflict", `Built-in theme "${id}" cannot be deleted.`);
    try {
      rmSync(customPath(id));
    } catch {
      throw new ServiceError("not_found", `Theme "${id}" was not found.`);
    }
    const settings = readSettings();
    if (settings.activeThemeId === id) writeSettings({ ...settings, activeThemeId: "default" });
    return { deleted: true };
  }

  function getSettings(): Settings {
    return readSettings();
  }

  function putSettings(patch: Partial<Settings>): Settings {
    const next = DeviceSettings.parse({ ...readSettings(), ...patch });
    if (patch.activeThemeId !== undefined) get(next.activeThemeId);
    return writeSettings(next);
  }

  function activate(id: string): Settings {
    get(id);
    return putSettings({ activeThemeId: id });
  }

  function importFromText(
    text: string,
    filename?: string,
    activateAfter?: boolean,
  ): ReturnType<typeof parseImport> {
    let theme: ReturnType<typeof parseImport>["theme"];
    let format: ReturnType<typeof parseImport>["format"];
    try {
      ({ theme, format } = parseImport(text, filename));
    } catch (error) {
      throw new ServiceError(
        "bad_request",
        error instanceof Error ? error.message : "Could not import theme.",
      );
    }
    if (allBuiltins().some((built) => built.id === theme.id)) {
      theme = AppearanceTheme.parse({ ...theme, id: `${theme.id}-custom` });
    }
    const saved = put(theme);
    if (activateAfter) putSettings({ activeThemeId: saved.id });
    return { theme: saved, format };
  }

  return {
    list,
    get,
    put,
    remove,
    getSettings,
    putSettings,
    importFromText,
    activate,
    themesDir,
    settingsPath,
    home,
  };
}

export type ThemeStore = ReturnType<typeof createThemeStore>;
