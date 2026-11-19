import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
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
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const changed = new Set<string>();
  let settingsDirty = false;

  const flush = () => {
    const changedIds = [...changed];
    changed.clear();
    if (changedIds.length === 0 && !settingsDirty) return;
    const activeThemeId = themes.getSettings().activeThemeId;
    broadcast({ push: "themes", activeThemeId, changedIds });
    settingsDirty = false;
  };

  const schedule = (key: string, run: () => void) => {
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        run();
        flush();
      }, 100),
    );
  };

  const watchers: FSWatcher[] = [];

  try {
    watchers.push(
      watch(themes.themesDir, { persistent: false }, (_event, filename) => {
        if (!filename || IGNORED_NAME_RE.test(filename)) return;
        const id = themeIdFromPath(themes.themesDir, join(themes.themesDir, filename));
        schedule(`theme:${filename}`, () => {
          if (id) changed.add(id);
        });
      }),
    );
  } catch {
    /* themes dir may be missing until first use */
  }

  try {
    watchers.push(
      watch(themes.settingsPath, { persistent: false }, () => {
        schedule("settings", () => {
          settingsDirty = true;
        });
      }),
    );
  } catch {
    /* settings file may not exist yet */
  }

  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const w of watchers) w.close();
  };
}
