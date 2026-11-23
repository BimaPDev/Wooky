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
      [{ summary: "s", kind: "note", bogus: 1 }, /not allowed/],
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

describe("hostile files never make a read throw", () => {
  it.each(["10000-01-01", "+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00Z", "99999-12-31"])(
    "falls back to the file time for updatedAt %s",
    (updatedAt) => {
      const parsed = parseMemory(
        `---\nsummary: "ok"\nkind: "note"\nupdatedAt: ${JSON.stringify(updatedAt)}\n---\n\nBody\n`,
        mtime,
      );
      expect(parsed.frontmatter.updatedAt).toBe(mtime);
      expect(parsed.frontmatter.summary).toBe("ok");
    },
  );

  it("survives a file time the schema cannot hold", () => {
    expect(parseMemory("plain text", "+010000-01-01T00:00:00.000Z").frontmatter.updatedAt).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(parseMemory("---\nsummary: x\n---\n", "garbage").frontmatter.updatedAt).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("never throws on random and hostile frontmatter (fuzz)", () => {
    let state = 0x2f6e2b1;
    const next = (limit: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % limit;
    };
    const values = [
      '"10000-01-01"',
      '"+010000-01-01T00:00:00.000Z"',
      '"-000001-01-01"',
      '"2026-13-45T99:99:99Z"',
      "null",
      "true",
      "[]",
      "{}",
      "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[",
      '{"a":{"b":{"c":[1,2,3]}}}',
      '"\\u0000\\ud800"',
      "__proto__",
      "[a, b,, c",
      '"x"'.repeat(50),
      "9".repeat(400),
      '{"threadId":1,"at":"nope"}',
      '["Bad Tag", 5, null, "ok"]',
      "'single quoted'",
      "",
    ];
    const keys = [
      "summary",
      "kind",
      "tags",
      "status",
      "pinned",
      "updatedAt",
      "source",
      "__proto__",
      "constructor",
      "toString",
      "x y",
      "",
    ];
    const pieces = ["---\n", "---", "\r\n", "\n", "\u0000", "﻿", "# heading\n", "text ", " "];
    for (let run = 0; run < 800; run += 1) {
      let text = next(4) === 0 ? "" : "---\n";
      for (let line = next(8); line > 0; line -= 1) {
        text += `${keys[next(keys.length)] ?? ""}: ${values[next(values.length)] ?? ""}\n`;
        if (next(4) === 0) text += pieces[next(pieces.length)] ?? "";
      }
      text += next(5) === 0 ? "" : `---\n\n${pieces[next(pieces.length)] ?? ""}body\n`;
      const parsed = parseMemory(text, next(3) === 0 ? "nope" : mtime);
      expect(parsed.frontmatter.summary.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(parsed.frontmatter.updatedAt))).toBe(false);
    }
  });

  it("names a field path but never an unrecognized key or a rejected value", () => {
    const secretKey = "zzunique_key_name";
    let message = "";
    try {
      parseFrontmatterInput({ summary: "s", kind: "note", [secretKey]: "zzunique_value" }, at);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not allowed/);
    expect(message).not.toContain(secretKey);
    expect(message).not.toContain("zzunique_value");
    expect(message).not.toMatch(/ZodError|origin|pattern/);
  });
});
