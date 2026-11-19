import type { FileDiff, ReviewNote } from "@wooky/contracts";
import { Fragment, memo, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseUnifiedDiff } from "../lib/diff.ts";
import { IconChevron } from "./Icons.tsx";
import { Tooltip } from "./Tooltip.tsx";
import {
  anchorForLine,
  anchorKey,
  groupNotesByAnchor,
  noteLabel,
  type NoteAnchor,
} from "./review/notes.ts";
import { NoteComposer, ReviewNoteItem } from "./review/ReviewNotes.tsx";
import { isStale } from "./review/snippets.ts";

const NO_NOTES: readonly ReviewNote[] = [];
const NO_SNIPPETS: Readonly<Record<string, string>> = {};

interface Compose {
  row: number;
  anchor: NoteAnchor;
}

/**
 * Unified diff body: line numbers, tinted additions and removals. With a thread id and a path,
 * each line takes a review note: a "+" in the gutter, Enter or c on a focused line. Notes whose
 * line changed since they were written are marked; notes whose line is gone stay listed below.
 */
export const DiffLines = memo(function DiffLines({
  patch,
  threadId,
  path,
  notes = NO_NOTES,
  snippets = NO_SNIPPETS,
}: {
  patch: string;
  threadId?: string;
  path?: string;
  notes?: readonly ReviewNote[];
  /** Line text each note was written against, by note id. Client-side only. */
  snippets?: Readonly<Record<string, string>>;
}) {
  const hunks = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const reviewPath = threadId !== undefined ? (path ?? null) : null;
  const review =
    threadId !== undefined && reviewPath !== null ? { threadId, path: reviewPath } : null;
  const span = review ? 4 : 3;
  const anchors = useMemo(
    () =>
      reviewPath === null
        ? []
        : hunks.flatMap((hunk) => hunk.lines.map((line) => anchorForLine(reviewPath, line))),
    [hunks, reviewPath],
  );
  // Index of each hunk's first line in the flattened list of lines.
  const offsets = useMemo(
    () =>
      hunks.map((_, h) => hunks.slice(0, h).reduce((total, hunk) => total + hunk.lines.length, 0)),
    [hunks],
  );
  // The text now shown at each anchor, keyed the same way notes are.
  const lineTexts = useMemo(() => {
    const texts = new Map<string, string>();
    if (reviewPath === null) return texts;
    for (const hunk of hunks)
      for (const line of hunk.lines) {
        const anchor = anchorForLine(reviewPath, line);
        if (anchor) texts.set(anchorKey(anchor), line.text);
      }
    return texts;
  }, [hunks, reviewPath]);
  const notesByAnchor = useMemo(() => groupNotesByAnchor(notes), [notes]);
  const orphans = useMemo(
    () => notes.filter((note) => !lineTexts.has(anchorKey(note))),
    [notes, lineTexts],
  );
  const stale = useMemo(
    () =>
      new Set(
        notes
          .filter((note) => isStale(snippets[note.id], lineTexts.get(anchorKey(note)) ?? null))
          .map((note) => note.id),
      ),
    [notes, snippets, lineTexts],
  );
  const tableRef = useRef<HTMLTableElement>(null);
  const [compose, setCompose] = useState<Compose | null>(null);

  const openAt = (row: number) => {
    const anchor = anchors[row];
    if (anchor) setCompose({ row, anchor });
  };
  const closeCompose = (row: number) => {
    setCompose(null);
    tableRef.current?.querySelector<HTMLElement>(`tr[data-row="${row}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("tr[data-row]"));
    if (target === event.currentTarget) {
      if (event.key === "ArrowDown" && rows[0]) {
        event.preventDefault();
        rows[0].focus();
      }
      return;
    }
    const index = rows.indexOf(target);
    if (index < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (
      (event.key === "Enter" || event.key === "c") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      openAt(Number(target.dataset.row));
    }
  };

  const table = (
    <table className="diff" ref={tableRef}>
      {hunks.map((hunk, h) => {
        const offset = offsets[h] ?? 0;
        return (
          <tbody key={h}>
            <tr className="diff-hunk">
              <td colSpan={span}>{hunk.header}</td>
            </tr>
            {hunk.lines.map((line, i) => {
              const row = offset + i;
              const anchor = anchors[row] ?? null;
              const rowNotes = anchor
                ? (notesByAnchor.get(anchorKey(anchor)) ?? NO_NOTES)
                : NO_NOTES;
              return (
                <Fragment key={row}>
                  <tr
                    className={`diff-line diff-${line.kind}`}
                    data-row={review ? row : undefined}
                    tabIndex={review ? -1 : undefined}
                  >
                    {review ? (
                      <td className="diff-gutter">
                        {anchor ? (
                          <Tooltip label="Add review note">
                            <button
                              type="button"
                              tabIndex={-1}
                              className="diff-gutter-button"
                              aria-label={`Add review note on ${noteLabel(anchor)}`}
                              onClick={() => openAt(row)}
                            >
                              +
                            </button>
                          </Tooltip>
                        ) : null}
                      </td>
                    ) : null}
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
                  {review && rowNotes.length > 0
                    ? rowNotes.map((note) => (
                        <tr key={note.id} className="review-note-row">
                          <td colSpan={span}>
                            <ReviewNoteItem
                              threadId={review.threadId}
                              note={note}
                              stale={stale.has(note.id)}
                            />
                          </td>
                        </tr>
                      ))
                    : null}
                  {review && anchor && compose?.row === row ? (
                    <tr className="review-compose-row">
                      <td colSpan={span}>
                        <NoteComposer
                          threadId={review.threadId}
                          anchor={anchor}
                          lineText={line.text}
                          onDone={() => closeCompose(row)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        );
      })}
      {review && orphans.length > 0 ? (
        <tbody className="review-orphans">
          <tr>
            <td colSpan={span} className="review-orphans-head">
              Lines no longer in this diff
            </td>
          </tr>
          {orphans.map((note) => (
            <tr key={note.id} className="review-note-row">
              <td colSpan={span}>
                <ReviewNoteItem threadId={review.threadId} note={note} stale={stale.has(note.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      ) : null}
    </table>
  );

  if (hunks.length === 0 && orphans.length === 0)
    return <p className="diff-empty">No textual changes.</p>;
  if (!review) return table;
  return (
    <div
      className="diff-wrap"
      role="group"
      tabIndex={0}
      aria-label={`Lines of ${review.path}. Arrow keys move between lines. Enter or c adds a note.`}
      onKeyDown={onKeyDown}
    >
      {table}
    </div>
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

export function FileDiffView({
  file,
  defaultOpen,
  threadId,
  notes,
  snippets,
}: {
  file: FileDiff;
  defaultOpen: boolean;
  /** Set to review lines of this thread. Omit for a read-only diff. */
  threadId?: string;
  notes?: readonly ReviewNote[];
  snippets?: Readonly<Record<string, string>>;
}) {
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
          <DiffLines
            patch={file.patch}
            threadId={threadId}
            path={threadId !== undefined ? file.path : undefined}
            notes={notes}
            snippets={snippets}
          />
        ) : (
          <p className="diff-empty">Binary file, no preview.</p>
        )
      ) : null}
    </section>
  );
}

export const fileAnchor = (path: string) => `diff-${path.replace(/[^\w-]/g, "_")}`;
