import type { FileDiff } from "@age/contracts";
import { memo, useMemo, useState } from "react";
import { parseUnifiedDiff } from "../lib/diff.ts";
import { IconChevron } from "./Icons.tsx";

/** Unified diff body: line numbers, tinted additions and removals. */
export const DiffLines = memo(function DiffLines({ patch }: { patch: string }) {
  const hunks = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (hunks.length === 0) return <p className="diff-empty">No textual changes.</p>;
  return (
    <table className="diff">
      {hunks.map((hunk, h) => (
        <tbody key={h}>
          <tr className="diff-hunk">
            <td colSpan={3}>{hunk.header}</td>
          </tr>
          {hunk.lines.map((line, i) => (
            <tr key={i} className={`diff-line diff-${line.kind}`}>
              <td className="diff-no" aria-hidden="true">
                {line.oldNo ?? ""}
              </td>
              <td className="diff-no" aria-hidden="true">
                {line.newNo ?? ""}
              </td>
              <td className="diff-text">
                <span className="diff-sign" aria-hidden="true">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                {line.kind === "meta" ? <em>{line.text}</em> : line.text}
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
});

const statusLabel: Record<FileDiff["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="counts">
      <span className="count-add">+{additions}</span>
      <span className="count-del">-{deletions}</span>
    </span>
  );
}

export function FileDiffView({ file, defaultOpen }: { file: FileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="file-diff" id={fileAnchor(file.path)}>
      <button
        type="button"
        className="file-diff-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <IconChevron open={open} />
        <span className="mono file-path">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="file-status">{statusLabel[file.status]}</span>
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        file.patch ? (
          <DiffLines patch={file.patch} />
        ) : (
          <p className="diff-empty">Binary file, no preview.</p>
        )
      ) : null}
    </section>
  );
}

export const fileAnchor = (path: string) => `diff-${path.replace(/[^\w-]/g, "_")}`;
