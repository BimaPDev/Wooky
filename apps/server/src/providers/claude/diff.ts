import { relPath, str, targetPath, type ToolInput } from "./tools.ts";
import { truncateBytes } from "./text.ts";

const DIFF_MAX_BYTES = 8 * 1024;

function lines(text: string, prefix: string): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

function hunk(oldText: string | undefined, newText: string | undefined): string[] {
  return [
    "@@",
    ...(oldText === undefined ? [] : lines(oldText, "-")),
    ...(newText === undefined ? [] : lines(newText, "+")),
  ];
}

/** Small unified-diff-style preview of an edit tool call, capped at 8 KB. */
export function editPreview(name: string, input: ToolInput, cwd: string): string | undefined {
  const path = targetPath(input);
  const hunks: string[][] = [];

  if (name === "Edit") {
    const next = input["new_string"];
    if (typeof next === "string") hunks.push(hunk(str(input, "old_string") ?? "", next));
  } else if (name === "MultiEdit") {
    const edits = input["edits"];
    if (Array.isArray(edits)) {
      for (const edit of edits) {
        if (typeof edit !== "object" || edit === null) continue;
        const { old_string: before, new_string: after } = edit as Record<string, unknown>;
        if (typeof after === "string")
          hunks.push(hunk(typeof before === "string" ? before : "", after));
      }
    }
  } else if (name === "Write") {
    const content = input["content"];
    if (typeof content === "string") hunks.push(hunk(undefined, content));
  } else if (name === "NotebookEdit") {
    const source = input["new_source"];
    if (typeof source === "string") hunks.push(hunk(undefined, source));
  }

  if (hunks.length === 0) return undefined;
  const rel = path ? relPath(path, cwd) : "file";
  const text = [`--- a/${rel}`, `+++ b/${rel}`, ...hunks.flat()].join("\n");
  return truncateBytes(text, DIFF_MAX_BYTES, "\n… diff truncated");
}
