import { describe, expect, it } from "vitest";
import { countChanges, parseUnifiedDiff } from "./diff.ts";

describe("parseUnifiedDiff", () => {
  it("numbers lines across hunks and skips file headers", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@ export",
      " one",
      "-two",
      "+deux",
      " three",
      "@@ -10,2 +10,3 @@",
      " ten",
      "+ten and a half",
      " eleven",
      "",
    ].join("\n");
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe("@@ -1,3 +1,3 @@ export");
    expect(hunks[0]?.lines).toEqual([
      { kind: "ctx", text: "one", oldNo: 1, newNo: 1 },
      { kind: "del", text: "two", oldNo: 2, newNo: null },
      { kind: "add", text: "deux", oldNo: null, newNo: 2 },
      { kind: "ctx", text: "three", oldNo: 3, newNo: 3 },
    ]);
    expect(hunks[1]?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 10, 10],
      ["add", null, 11],
      ["ctx", 11, 12],
    ]);
    expect(countChanges(hunks)).toEqual({ additions: 2, deletions: 1 });
  });

  it("keeps the no-newline marker as an unnumbered meta line", () => {
    const hunks = parseUnifiedDiff(
      "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n",
    );
    expect(hunks[0]?.lines).toEqual([
      { kind: "del", text: "a", oldNo: 1, newNo: null },
      { kind: "meta", text: "No newline at end of file", oldNo: null, newNo: null },
      { kind: "add", text: "b", oldNo: null, newNo: 1 },
      { kind: "meta", text: "No newline at end of file", oldNo: null, newNo: null },
    ]);
  });

  it("handles new-file hunks starting at zero", () => {
    const hunks = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+x\n+y\n");
    expect(hunks[0]?.lines.map((l) => l.newNo)).toEqual([1, 2]);
  });
});
