import { describe, expect, it } from "vitest";
import { createNdjsonSplitter } from "./ndjson.ts";

describe("createNdjsonSplitter", () => {
  it("splits lines on newline boundaries", () => {
    const s = createNdjsonSplitter();
    expect(s.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("buffers partial lines across arbitrary chunk boundaries", () => {
    const s = createNdjsonSplitter();
    const chunks = ['{"ty', 'pe":"x"', "}\n", '{"y":', "2}\n"];
    const lines: string[] = [];
    for (const c of chunks) lines.push(...s.push(c));
    expect(lines).toEqual(['{"type":"x"}', '{"y":2}']);
  });

  it("flush returns a trailing line without newline", () => {
    const s = createNdjsonSplitter();
    s.push('{"tail":true}');
    expect(s.flush()).toBe('{"tail":true}');
    expect(s.flush()).toBeNull();
  });
});
