import { describe, expect, it } from "vitest";
import { openCodeArgs, parseOpenCodeModels, parseOpenCodeVersion } from "./models.ts";

describe("opencode model list", () => {
  it("keeps one id per line and drops blanks, duplicates, and prose", () => {
    expect(
      parseOpenCodeModels(
        "opencode/big-pickle\nopencode/deepseek-v4.1-flash-free\n\nnot a model\nopencode/big-pickle\n",
      ),
    ).toEqual(["opencode/big-pickle", "opencode/deepseek-v4.1-flash-free"]);
  });

  it("reads a version and builds argv without a shell", () => {
    expect(parseOpenCodeVersion("opencode 1.19.6\n", "")).toBe("1.19.6");
    expect(openCodeArgs(["/usr/bin/node", "cli.js"], ["--pure"])).toEqual({
      version: ["/usr/bin/node", "cli.js", "--version"],
      models: ["/usr/bin/node", "cli.js", "models"],
      acp: ["/usr/bin/node", "cli.js", "acp", "--pure"],
    });
  });
});
