import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThemesPush } from "@age/contracts";
import type { ThemeStore } from "./themes.ts";

const IGNORED_NAME_RE = /(?:^|[/\\])\.|~$|\.tmp$|\.swp$|\.bak$/;

function themeIdFromPath(themesDir: string, filePath: string): string | null {
  if (!filePath.startsWith(themesDir)) return null;
  const name = filePath.slice(themesDir.length).replace(/^[/\\]/, "");
  if (!name.endsWith(".json")) return null;
  return name.slice(0, -".json".length);
}

export function watchThemeFiles(
  themes: ThemeStore,
  broadcast: (message: ThemesPush) => void,
): () => void {
  const changed = new Set<string>();
  let settingsDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const changedIds = [...changed];
    changed.clear();
    if (changedIds.length === 0 && !settingsDirty) return;
    const activeThemeId = themes.getSettings().activeThemeId;
    broadcast({ push: "themes", activeThemeId, changedIds });
    settingsDirty = false;
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 100);
  };

  const watchers: FSWatcher[] = [];

  // Watch directories, not files: settings.json may not exist yet, and editors and the
  // CLI may replace it by rename, which a file watcher on macOS never sees.
  const settingsDir = dirname(themes.settingsPath);
  const settingsName = basename(themes.settingsPath);
  try {
    mkdirSync(themes.themesDir, { recursive: true });
    watchers.push(
      watch(themes.themesDir, { persistent: false }, (_event, filename) => {
        if (!filename || IGNORED_NAME_RE.test(filename)) return;
        const id = themeIdFromPath(themes.themesDir, join(themes.themesDir, filename));
        if (id) changed.add(id);
        schedule();
      }),
    );
  } catch (error) {
    console.warn("Theme folder watch unavailable", error);
  }

  try {
    mkdirSync(settingsDir, { recursive: true });
    watchers.push(
      watch(settingsDir, { persistent: false }, (_event, filename) => {
        if (filename !== settingsName) return;
        settingsDirty = true;
        schedule();
      }),
    );
  } catch (error) {
    console.warn("Settings watch unavailable", error);
  }

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const w of watchers) w.close();
  };
}
