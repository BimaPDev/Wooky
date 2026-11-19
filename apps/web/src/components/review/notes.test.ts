import type { ReviewNote } from "@wooky/contracts";
import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../lib/diff.ts";
import {
  anchorForLine,
  anchorKey,
  groupNotesByAnchor,
  groupNotesByPath,
  mergeBlock,
  reviewBarLabel,
  sendHint,
  sendLabel,
  shortSha,
} from "./notes.ts";

const line = (kind: DiffLine["kind"], oldNo: number | null, newNo: number | null): DiffLine => ({
  kind,
  text: "x",
  oldNo,
  newNo,
});

const key = (path: string, side: "old" | "new", lineNo: number) =>
  anchorKey({ path, side, line: lineNo });

const note = (id: string, path: string, lineNo: number, side: "old" | "new"): ReviewNote => ({
  id,
  threadId: "t1",
  path,
  line: lineNo,
  side,
  body: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("anchorForLine", () => {
  it("anchors added and context lines to the new file", () => {
    expect(anchorForLine("a.ts", line("add", null, 7))).toEqual({
      path: "a.ts",
      side: "new",
      line: 7,
    });
    expect(anchorForLine("a.ts", line("ctx", 3, 4))).toEqual({
      path: "a.ts",
      side: "new",
      line: 4,
    });
  });

  it("anchors removed lines to the old file", () => {
    expect(anchorForLine("a.ts", line("del", 9, null))).toEqual({
      path: "a.ts",
      side: "old",
      line: 9,
    });
  });

  it("gives no anchor to meta lines", () => {
    expect(anchorForLine("a.ts", line("meta", null, null))).toBeNull();
  });
});

describe("note anchoring", () => {
  it("keeps the same line on the old and new side apart", () => {
    const groups = groupNotesByAnchor([
      note("n1", "a.ts", 4, "new"),
      note("n2", "a.ts", 4, "old"),
      note("n3", "b.ts", 4, "new"),
      note("n4", "a.ts", 4, "new"),
    ]);
    expect(groups.get(key("a.ts", "new", 4))?.map((n) => n.id)).toEqual(["n1", "n4"]);
    expect(groups.get(key("a.ts", "old", 4))?.map((n) => n.id)).toEqual(["n2"]);
    expect(groups.get(key("b.ts", "new", 4))?.map((n) => n.id)).toEqual(["n3"]);
    expect(groups.get(key("a.ts", "new", 5))).toBeUndefined();
  });

  it("groups notes by file for the changes panel", () => {
    const groups = groupNotesByPath([note("n1", "a.ts", 1, "new"), note("n2", "b.ts", 2, "old")]);
    expect([...groups.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(groups.get("b.ts")?.[0]?.id).toBe("n2");
  });
});

describe("review bar copy", () => {
  it("counts notes in words a person reads", () => {
    expect(reviewBarLabel(1)).toBe("1 review note");
    expect(reviewBarLabel(3)).toBe("3 review notes");
  });

  it("says the notes will be queued while the agent is busy", () => {
    expect(sendLabel(false)).toBe("Send to agent");
    expect(sendLabel(true)).toBe("Queue for agent");
    expect(sendHint(false)).toBeNull();
    expect(sendHint(true)).toContain("queued");
  });
});

describe("merge gating", () => {
  const ready = { hasWorktree: true, busy: false, merging: false, conflicts: 0 };

  it("allows a merge when a worktree is idle and conflict-free", () => {
    expect(mergeBlock(ready)).toBeNull();
  });

  it("explains each reason it is blocked", () => {
    expect(mergeBlock({ ...ready, hasWorktree: false })).toMatch(/project folder/);
    expect(mergeBlock({ ...ready, busy: true })).toMatch(/running turn/);
    expect(mergeBlock({ ...ready, conflicts: 2 })).toMatch(/conflicts/);
    expect(mergeBlock({ ...ready, merging: true })).toMatch(/already running/);
  });

  it("shortens a commit to seven characters", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});
