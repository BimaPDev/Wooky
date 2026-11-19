import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
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

/** Theme id → mtime, so a flush can find changes even when the OS merges or drops events. */
function snapshotThemes(themesDir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  try {
    for (const name of readdirSync(themesDir)) {
      if (!name.endsWith(".json") || IGNORED_NAME_RE.test(name)) continue;
      try {
        snapshot.set(name.slice(0, -".json".length), statSync(join(themesDir, name)).mtimeMs);
      } catch {
        /* removed between readdir and stat */
      }
    }
  } catch {
    /* folder missing */
  }
  return snapshot;
}

export function watchThemeFiles(
  themes: ThemeStore,
  broadcast: (message: ThemesPush) => void,
): () => void {
  const changed = new Set<string>();
  let settingsDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let known = snapshotThemes(themes.themesDir);
  const flush = () => {
    timer = null;
    const next = snapshotThemes(themes.themesDir);
    for (const [id, mtime] of next) if (known.get(id) !== mtime) changed.add(id);
    for (const id of known.keys()) if (!next.has(id)) changed.add(id);
    known = next;
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
        // A missing filename still schedules a flush; the mtime diff finds the change.
        if (filename && IGNORED_NAME_RE.test(filename)) return;
        if (filename) {
          const id = themeIdFromPath(themes.themesDir, join(themes.themesDir, filename));
          if (id) changed.add(id);
        }
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
