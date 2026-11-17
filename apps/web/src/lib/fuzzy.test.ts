import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.ts";

describe("fuzzy", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("nt", "New thread")).not.toBeNull();
    expect(fuzzyScore("NEWT", "new thread")).not.toBeNull();
    expect(fuzzyScore("xyz", "New thread")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("ranks word-start matches above scattered ones", () => {
    const items = ["Toggle theme", "Add project", "New thread", "Jump to thread: Fix the tests"];
    expect(fuzzyFilter(items, "tt", (s) => s)[0]).toBe("Toggle theme");
    expect(fuzzyFilter(items, "new", (s) => s)[0]).toBe("New thread");
    expect(fuzzyFilter(items, "fix", (s) => s)).toEqual(["Jump to thread: Fix the tests"]);
  });

  it("keeps original order for an empty query", () => {
    expect(fuzzyFilter(["b", "a"], " ", (s) => s)).toEqual(["b", "a"]);
  });
});
