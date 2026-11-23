import { describe, expect, it } from "vitest";
import {
  deriveSummary,
  normalizeBody,
  parseFrontmatterInput,
  parseMemory,
  serializeMemory,
} from "./frontmatter.ts";

const at = "2026-01-01T00:00:00.000Z";
const mtime = "2026-02-02T00:00:00.000Z";

describe("frontmatter", () => {
  it("round-trips every field, including awkward strings", () => {
    const frontmatter = parseFrontmatterInput(
      {
        summary: 'Use "pnpm": it\'s faster — see #42, café ✓',
        kind: "convention",
        tags: ["tooling", "ci:node"],
        status: "proposed",
        pinned: true,
        source: { threadId: "t1", turnId: "u1", fleetRunId: "f1", agent: "claude", at },
      },
      at,
    );
    const body = "# Title\n\n---\nnot a fence\n---\n\nKey: value\n";
    const parsed = parseMemory(serializeMemory(frontmatter, body), mtime);
    expect(parsed.plain).toBe(false);
    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe(body);
  });

  it("writes one JSON value per line", () => {
    const text = serializeMemory(
      parseFrontmatterInput({ summary: "s", kind: "note" }, at),
      "hello",
    );
    expect(text).toBe(
      `---\nsummary: "s"\nkind: "note"\ntags: []\nstatus: "active"\nupdatedAt: "${at}"\n---\n\nhello\n`,
    );
  });

  it("normalizes bodies", () => {
    expect(normalizeBody("\r\n\r\nhi\r\nthere  \n\n\n")).toBe("hi\nthere\n");
    expect(normalizeBody("  \n")).toBe("");
  });

  describe("writing is strict", () => {
    it.each([
      [{ summary: "s", kind: "note", bogus: 1 }, /bogus/],
      [{ summary: "s", kind: "rant" }, /kind/],
      [{ summary: "", kind: "note" }, /summary/],
      [{ summary: "a\nb", kind: "note" }, /single line/],
      [{ summary: "x".repeat(201), kind: "note" }, /summary/],
      [{ summary: "s", kind: "note", tags: ["Bad Tag"] }, /tags/],
      [{ summary: "s", kind: "note", status: "deleted" }, /status/],
      [{ summary: "s", kind: "note", updatedAt: at }, /updatedAt/],
      [{ summary: "s", kind: "note", source: { nope: 1 } }, /source/],
      [{ kind: "note" }, /summary/],
      ["nope", /frontmatter/],
    ])("rejects %j", (input, message) => {
      expect(() => parseFrontmatterInput(input, at)).toThrow(message);
    });
  });

  describe("reading is forgiving", () => {
    it("turns a file with no frontmatter into a note", () => {
      const parsed = parseMemory("# Use pnpm everywhere\n\nBecause it is fast.\n", mtime);
      expect(parsed.plain).toBe(true);
      expect(parsed.frontmatter).toMatchObject({
        summary: "Use pnpm everywhere",
        kind: "note",
        status: "active",
        tags: [],
        updatedAt: mtime,
      });
      expect(parsed.body).toContain("Because it is fast.");
    });

    it("keeps what is valid and defaults the rest", () => {
      const parsed = parseMemory(
        [
          "---",
          "title: ignored",
          "summary: A hand written summary",
          "kind: rant",
          "tags: [Alpha, beta gamma, delta]",
          "status: draft",
          "pinned: true",
          "updatedAt: 2026-03-04",
          "---",
          "",
          "Body",
        ].join("\r\n"),
        mtime,
      );
      expect(parsed.frontmatter).toEqual({
        summary: "A hand written summary",
        kind: "note",
        tags: ["alpha", "delta"],
        status: "active",
        pinned: true,
        updatedAt: "2026-03-04T00:00:00.000Z",
      });
      expect(parsed.body).toBe("Body");
    });

    it("derives the summary from the body when it is missing", () => {
      const parsed = parseMemory(
        "---\nkind: lesson\n---\n\n- **Always** run `pnpm check`\n",
        mtime,
      );
      expect(parsed.frontmatter).toMatchObject({
        kind: "lesson",
        summary: "Always run pnpm check",
      });
    });

    it("treats an unclosed fence as plain text", () => {
      const parsed = parseMemory("---\nsummary: x\nno closing fence\n", mtime);
      expect(parsed.plain).toBe(true);
    });

    it("cuts long first lines to 200 characters", () => {
      expect(deriveSummary("y".repeat(500))).toHaveLength(200);
      expect(deriveSummary("\n\n")).toBe("Empty note");
    });
  });
});
