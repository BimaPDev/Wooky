import { describe, expect, it } from "vitest";
import { countHiddenChips } from "./fit-chips.ts";

describe("countHiddenChips", () => {
  it("hides nothing when every chip fits, including a lone chip filling the budget exactly", () => {
    expect(countHiddenChips([80], 80, 4, 32)).toBe(0);
    expect(countHiddenChips([80, 60], 144, 4, 32)).toBe(0);
  });

  it("hides the trailing chips that do not fit and keeps room for the overflow button", () => {
    // 32 (button) + 4 + 80 = 116 fits; adding 4 + 60 = 180 does not.
    expect(countHiddenChips([80, 60, 60], 150, 4, 32)).toBe(2);
  });

  it("hides every chip when none fits next to the overflow button", () => {
    expect(countHiddenChips([80, 60], 40, 4, 32)).toBe(2);
  });
});
