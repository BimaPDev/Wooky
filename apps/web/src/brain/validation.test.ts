import { BRAIN_BODY_MAX_BYTES, BRAIN_SUMMARY_MAX } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import {
  parentFolderUri,
  validateBrainMemoryPath,
  validateBrainTags,
  validateMemoryDraft,
} from "./validation.ts";

describe("brain validation", () => {
  it("accepts valid scope-relative memory paths and rejects docs/brain.md violations", () => {
    expect(validateBrainMemoryPath("lessons/pnpm.md")).toBeNull();
    expect(validateBrainMemoryPath("a/b/c/d/e/f.md")).toBeNull();

    expect(validateBrainMemoryPath("")).toContain("Enter a memory path");
    expect(validateBrainMemoryPath("lessons/pnpm")).toContain(".md");
    expect(validateBrainMemoryPath("Lessons/pnpm.md")).toContain("lowercase");
    expect(validateBrainMemoryPath("../secret.md")).toContain("..");
    expect(validateBrainMemoryPath("/abs/path.md")).toContain("relative");
    expect(validateBrainMemoryPath("a\\b.md")).toContain("relative");
    expect(validateBrainMemoryPath("a//b.md")).toContain("empty segments");
    expect(validateBrainMemoryPath("a%20b.md")).toContain("%");
    expect(validateBrainMemoryPath(".hidden/note.md")).toContain("dot");
    expect(validateBrainMemoryPath("folder./note.md")).toContain("dot");
    expect(validateBrainMemoryPath("con.md")).toContain("device name");
    expect(validateBrainMemoryPath("lessons/_overview.md")).toContain("_overview.md");
    expect(validateBrainMemoryPath("folder.md/note.md")).toContain("final file name");
    expect(validateBrainMemoryPath("a/b/c/d/e/f/g.md")).toContain("at most 6 segments");
  });

  it("validates tags, summary, and body byte cap", () => {
    expect(validateBrainTags("tooling, pnpm pnpm")).toEqual({
      tags: ["tooling", "pnpm"],
      error: null,
    });
    expect(validateBrainTags("BadTag").error).toContain("lowercase");
    expect(
      validateBrainTags(Array.from({ length: 13 }, (_, i) => `t${i}`).join(",")).error,
    ).toContain("at most 12");

    expect(
      validateMemoryDraft({
        path: "notes/test.md",
        isNew: true,
        summary: "",
        kind: "note",
        tagsRaw: "",
        body: "ok",
      }),
    ).toContain("Summary is required");

    expect(
      validateMemoryDraft({
        path: "notes/test.md",
        isNew: true,
        summary: "line1\nline2",
        kind: "note",
        tagsRaw: "",
        body: "ok",
      }),
    ).toContain("single line");

    expect(
      validateMemoryDraft({
        path: "notes/test.md",
        isNew: true,
        summary: "x".repeat(BRAIN_SUMMARY_MAX + 1),
        kind: "note",
        tagsRaw: "",
        body: "ok",
      }),
    ).toContain(`${BRAIN_SUMMARY_MAX}`);

    expect(
      validateMemoryDraft({
        path: "notes/test.md",
        isNew: true,
        summary: "ok",
        kind: "note",
        tagsRaw: "",
        body: "a".repeat(BRAIN_BODY_MAX_BYTES + 1),
      }),
    ).toContain("16 KB");
  });

  it("computes parent folder URIs", () => {
    expect(parentFolderUri("brain://global/lessons/sqlite.md")).toBe("brain://global/lessons");
    expect(parentFolderUri("brain://global/note.md")).toBe("brain://global/");
    expect(parentFolderUri("brain://project/p1/a/b.md")).toBe("brain://project/p1/a");
  });
});
