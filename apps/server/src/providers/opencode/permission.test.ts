import { describe, expect, it } from "vitest";
import { openCodePermission } from "./permission.ts";

describe("OpenCode permission mapping", () => {
  it("asks in approve, allows edits in auto-edits, and allows everything in full", () => {
    expect(openCodePermission("approve")).toEqual({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
    });
    expect(openCodePermission("auto-edits")).toEqual({
      edit: "allow",
      bash: "ask",
      webfetch: "ask",
    });
    expect(openCodePermission("full")).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    });
  });
});
