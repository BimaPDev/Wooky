import { describe, expect, it } from "vitest";
import { parseJsonSafely, sanitizeNote } from "./safe-input.ts";

describe("sanitizeNote", () => {
  it.each([
    ["Skipped file:///Users/me/work/a.db today", "Skipped <path> today"],
    ["Skipped ~/Library/foo.db", "Skipped <path>"],
    ["Skipped ~ entirely", "Skipped <path> entirely"],
    ["Cannot read Library/Application Support/foo", "Cannot read <path>"],
    ["Cannot read \\\\?\\C:\\Users\\x\\y.db", "Cannot read <path>"],
    ["Cannot read C:\\Users\\Some One\\y.db", "Cannot read <path>"],
    [
      "Skipped /Users/someone/my project/index.db and C:\\Users\\x\\y.db",
      "Skipped <path> and <path>",
    ],
    ["Opened 3/10 files", "Opened 3/10 files"],
  ])("%s", (input, expected) => {
    expect(sanitizeNote(input)).toBe(expected);
  });

  it("keeps the first sentence and caps the length", () => {
    expect(sanitizeNote("Partial scan. Another sentence with detail.")).toBe("Partial scan.");
    expect(sanitizeNote("x".repeat(500))?.length).toBe(200);
  });

  it("returns undefined for nothing", () => {
    expect(sanitizeNote(undefined)).toBeUndefined();
    expect(sanitizeNote("   ")).toBeUndefined();
  });
});

describe("parseJsonSafely", () => {
  it("drops prototype-polluting keys at any depth", () => {
    const parsed = parseJsonSafely(
      '{"__proto__":{"x":1},"a":{"constructor":2,"prototype":3,"b":4},"list":[{"__proto__":5}]}',
    ) as { a: Record<string, unknown>; list: Array<Record<string, unknown>> };
    expect(Object.hasOwn(parsed, "__proto__")).toBe(false);
    expect(parsed.a).toEqual({ b: 4 });
    expect(parsed.list).toEqual([{}]);
  });

  it("parses ordinary text unchanged", () => {
    expect(parseJsonSafely('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });
});
