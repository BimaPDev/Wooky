import { describe, expect, it } from "vitest";
import { mentionMenuFooter } from "./composer-mention-menu.ts";

describe("mentionMenuFooter", () => {
  it("shows searching while the active query has no settled response", () => {
    expect(mentionMenuFooter("src", null, 0, false)).toBe("searching");
    expect(mentionMenuFooter("src", "sr", 0, false)).toBe("searching");
  });

  it("shows no matches only after the response matches the current query", () => {
    expect(mentionMenuFooter("src", "src", 0, false)).toBe("no-matches");
  });

  it("shows nothing when results exist", () => {
    expect(mentionMenuFooter("src", "src", 2, false)).toBe("none");
  });
});
