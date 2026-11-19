import { describe, expect, it } from "vitest";
import { isTypingTarget, shouldFollowDrag } from "./guards.ts";

describe("isTypingTarget", () => {
  it("treats inputs, textareas, selects and contentEditable as typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("lets shortcuts through from buttons, panes and the window", () => {
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "SECTION" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget("INPUT")).toBe(false);
  });
});

describe("shouldFollowDrag", () => {
  const session = { pointerId: 7 };

  it("follows the pointer that started the drag while a button is down", () => {
    expect(shouldFollowDrag(session, { pointerId: 7, buttons: 1 })).toBe(true);
  });

  it("ignores a move with no button down, even from the same pointer", () => {
    expect(shouldFollowDrag(session, { pointerId: 7, buttons: 0 })).toBe(false);
  });

  it("ignores moves from another pointer", () => {
    expect(shouldFollowDrag(session, { pointerId: 8, buttons: 1 })).toBe(false);
  });
});
