import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_THEME_IMPORT_TEXT } from "./theme-import.ts";
import { createThemeStore } from "./themes.ts";

export const THEME_USAGE = `Usage: age theme <command>

  list              List installed theme ids
  set <file>        Import a theme file and activate it
  use <id>          Activate a theme by id
  off               Switch back to the default theme`;

function resolveAgeHome(env: Record<string, string | undefined>): string {
  return resolve(env.AGE_HOME ?? join(homedir(), ".age"));
}

export function runThemeCli(args: string[], env: Record<string, string | undefined>): void {
  const store = createThemeStore(resolveAgeHome(env));
  const [command, arg] = args;

  switch (command) {
    case "list": {
      const { themes } = store.list();
      for (const theme of themes) process.stdout.write(`${theme.id}\n`);
      return;
    }
    case "set": {
      if (!arg) throw new Error("Missing theme file path.");
      const text = readFileSync(resolve(arg), "utf8");
      if (text.length > MAX_THEME_IMPORT_TEXT) {
        throw new Error(`Theme import text exceeds ${MAX_THEME_IMPORT_TEXT} characters.`);
      }
      const { theme } = store.importFromText(text, arg, true);
      process.stdout.write(`${theme.id}\n`);
      return;
    }
    case "use": {
      if (!arg) throw new Error("Missing theme id.");
      store.activate(arg);
      return;
    }
    case "off": {
      store.activate("default");
      return;
    }
    default:
      process.stderr.write(`${THEME_USAGE}\n`);
      process.exit(command === undefined ? 0 : 1);
  }
}
