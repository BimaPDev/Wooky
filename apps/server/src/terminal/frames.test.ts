import { describe, expect, it } from "vitest";
import { holdIncompleteEscape, splitOutputFrames, trimReplayRing, utf8FrameEnd } from "./frames.ts";

describe("utf8FrameEnd", () => {
  it("does not split inside a multi-byte code point", () => {
    const emoji = Buffer.from("😀", "utf8");
    expect(emoji.length).toBe(4);
    expect(utf8FrameEnd(emoji, 0, 1)).toBe(4);
    expect(utf8FrameEnd(emoji, 0, 3)).toBe(4);
    expect(utf8FrameEnd(Buffer.from("a😀b", "utf8"), 0, 2)).toBe(1);
  });
});

describe("holdIncompleteEscape", () => {
  it("holds a trailing incomplete CSI for the next flush", () => {
    expect(holdIncompleteEscape("hello\x1b[31")).toEqual({
      ready: "hello",
      held: "\x1b[31",
    });
    expect(holdIncompleteEscape("hello\x1b")).toEqual({ ready: "hello", held: "\x1b" });
    expect(holdIncompleteEscape("hello\x1b[31m")).toEqual({
      ready: "hello\x1b[31m",
      held: "",
    });
  });

  it("does not hold when the last ESC is more than 64 characters back", () => {
    const text = `\x1b[${"0".repeat(70)}`;
    expect(holdIncompleteEscape(text)).toEqual({ ready: text, held: "" });
  });
});

describe("splitOutputFrames", () => {
  it("splits only at code-point boundaries", () => {
    const frames = splitOutputFrames("a😀b", 2);
    expect(frames.join("")).toBe("a😀b");
    expect(frames.some((frame) => frame.includes("\uFFFD"))).toBe(false);
    expect(frames[0]).toBe("a");
    expect(frames[1]).toBe("😀");
  });

  it("does not split between ESC and the end of its sequence", () => {
    const frames = splitOutputFrames("hello\x1b[31mred", 6);
    expect(frames.join("")).toBe("hello\x1b[31mred");
    expect(frames.some((frame) => frame.endsWith("\x1b"))).toBe(false);
    expect(frames.some((frame) => /\\x1b\[[^a-zA-Z@-~]*$/.test(frame))).toBe(false);
  });
});

describe("trimReplayRing", () => {
  it("starts just after the first newline in the retained window and prefixes SGR reset", () => {
    const ring = trimReplayRing(Buffer.alloc(0), Buffer.from("AAAA\nBBBB"), 6);
    expect(ring.toString("utf8")).toBe("\x1b[0mBBBB");
  });

  it("prefixes SGR reset when the retained window has no newline", () => {
    const ring = trimReplayRing(Buffer.alloc(0), Buffer.from("ABCDEF"), 4);
    expect(ring.toString("utf8")).toBe("\x1b[0mCDEF");
  });
});
