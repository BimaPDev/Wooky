import { describe, expect, it } from "vitest";
import { findHttpLinks, shouldOpenTerminalLink } from "./links.ts";

describe("findHttpLinks", () => {
  it("finds http and https URLs", () => {
    expect(findHttpLinks("see http://localhost:5173 and https://example.com/a")).toEqual([
      { text: "http://localhost:5173", start: 4, end: 25 },
      { text: "https://example.com/a", start: 30, end: 51 },
    ]);
  });

  it("trims trailing punctuation", () => {
    expect(findHttpLinks("go to https://example.com.")).toEqual([
      { text: "https://example.com", start: 6, end: 25 },
    ]);
  });
});

describe("shouldOpenTerminalLink", () => {
  it("opens on Cmd or Ctrl", () => {
    expect(shouldOpenTerminalLink({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldOpenTerminalLink({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(shouldOpenTerminalLink({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});
