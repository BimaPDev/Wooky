import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThemeStore } from "./themes.ts";
import { runThemeCli } from "./theme-cli.ts";
import { tempDir } from "../testing.ts";

const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#222"/></svg>`;

describe("theme CLI", () => {
  it("set imports a file, writes under WOOKY_HOME and activates it", async () => {
    const home = await tempDir("wooky-home");
    const file = join(home, "wall.svg");
    await writeFile(file, safeSvg, "utf8");

    const env = { ...process.env, WOOKY_HOME: home };
    runThemeCli(["set", file], env);

    const store = createThemeStore(home);
    expect(store.getSettings().activeThemeId).toBe("wall");
    const saved = await readFile(join(home, "themes", "wall.json"), "utf8");
    expect(saved).toContain('"id": "wall"');
  });
});
