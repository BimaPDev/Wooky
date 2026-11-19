import { describe, expect, it } from "vitest";
import { tempDir } from "../testing.ts";
import { validateThemeContent } from "./theme-validate.ts";
import { createThemeStore } from "./themes.ts";

describe("validateThemeContent", () => {
  it("passes every built-in theme", async () => {
    const store = createThemeStore(await tempDir("theme-validate-builtin"));
    const { themes } = store.list();
    for (const summary of themes) {
      if (!summary.builtin) continue;
      const theme = store.get(summary.id);
      expect(() => validateThemeContent(theme)).not.toThrow();
    }
  });
});
