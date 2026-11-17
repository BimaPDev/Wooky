export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Parse a unified patch into hunks with old/new line numbers. File headers are skipped. */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line.slice(1).trim(), oldNo: null, newNo: null });
    } else if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else {
      hunk = null;
    }
  }
  return hunks;
}

export function countChanges(hunks: readonly DiffHunk[]) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.kind === "add") additions++;
      else if (line.kind === "del") deletions++;
    }
  return { additions, deletions };
}
