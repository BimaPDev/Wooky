import { FLEET_LIMITS, type ReviewNote } from "@wooky/contracts";
import { useState } from "react";
import { addReviewNote, removeReviewNote } from "../../state/actions.ts";
import { IconTrash } from "../Icons.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { noteLabel, type NoteAnchor } from "./notes.ts";
import { snippetOf } from "./snippets.ts";

/** The inline composer under a diff line. Cmd+Enter adds, Escape cancels. */
export function NoteComposer({
  threadId,
  anchor,
  lineText,
  onDone,
}: {
  threadId: string;
  anchor: NoteAnchor;
  /** The line's text when the composer opened. Kept client-side to notice when the line changes. */
  lineText: string;
  onDone: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const text = body.trim();

  const save = async () => {
    if (!text || saving) return;
    setSaving(true);
    const ack = await addReviewNote(threadId, anchor, text, snippetOf(lineText));
    setSaving(false);
    if (ack) onDone();
  };

  return (
    <form
      className="review-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <textarea
        autoFocus
        rows={3}
        maxLength={FLEET_LIMITS.maxReviewBody}
        value={body}
        aria-label={`Review note on ${noteLabel(anchor)}`}
        placeholder="Leave a note for the agent"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
      />
      <div className="review-compose-actions">
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!text || saving}>
          Add note
        </button>
      </div>
    </form>
  );
}

/**
 * A note under its line. Author-less: the note is the agent's prompt, not a chat message.
 * `stale` keeps it visible and marks that its line changed since the note was written.
 */
export function ReviewNoteItem({
  threadId,
  note,
  stale = false,
}: {
  threadId: string;
  note: ReviewNote;
  stale?: boolean;
}) {
  const label = noteLabel(note);
  return (
    <div className={stale ? "review-note stale" : "review-note"}>
      <div className="review-note-head">
        <span className="mono review-note-anchor">{label}</span>
        <Tooltip label="Remove note">
          <button
            type="button"
            className="icon-button review-note-remove"
            aria-label={`Remove review note on ${label}`}
            onClick={() => void removeReviewNote(threadId, note.id)}
          >
            <IconTrash />
          </button>
        </Tooltip>
      </div>
      <p className="review-note-body">{note.body}</p>
      {stale ? <p className="review-note-stale">Line changed since this note</p> : null}
    </div>
  );
}
