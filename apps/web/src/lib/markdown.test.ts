import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.ts";

describe("markdown", () => {
  it("keeps HTML as plain text", () => {
    const blocks = parseMarkdown('<script>alert("x")</script> <img src=x onerror=y>');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: '<script>alert("x")</script> <img src=x onerror=y>' }],
      },
    ]);
  });

  it("renders fenced code verbatim, including an unclosed fence while streaming", () => {
    expect(parseMarkdown("Before\n\n```ts\nconst a = 1;\n**not bold**\n```\nAfter")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Before" }] },
      { type: "code", lang: "ts", text: "const a = 1;\n**not bold**" },
      { type: "paragraph", children: [{ type: "text", text: "After" }] },
    ]);
    expect(parseMarkdown("```\npartial")).toEqual([{ type: "code", lang: "", text: "partial" }]);
  });

  it("links only http and https", () => {
    expect(parseInline("[ok](https://example.com/a)")).toEqual([
      { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "ok" }] },
    ]);
    const unsafe = parseInline("[bad](javascript:alert(1))");
    expect(unsafe.some((node) => node.type === "link")).toBe(false);
    expect(unsafe[0]).toEqual({ type: "text", text: "bad" });
    expect(parseInline("[data](data:text/html,x)")).toEqual([{ type: "text", text: "data" }]);
  });

  it("parses inline emphasis, code, headings and lists", () => {
    expect(parseInline("a **b** *c* `d`")).toEqual([
      { type: "text", text: "a " },
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "code", text: "d" },
    ]);
    expect(parseInline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
    const blocks = parseMarkdown("## Plan\n\n- one\n- two\n\n1. first\n2. second");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "list", "list"]);
    expect(blocks[2]).toMatchObject({ type: "list", ordered: true });
  });
});
