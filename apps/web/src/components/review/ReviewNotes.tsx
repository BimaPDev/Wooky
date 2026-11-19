import { FLEET_LIMITS, type ReviewNote } from "@age/contracts";
import { useState } from "react";
import { addReviewNote, removeReviewNote } from "../../state/actions.ts";
import { IconTrash } from "../Icons.tsx";
import { noteLabel, type NoteAnchor } from "./notes.ts";

/** The inline composer under a diff line. Cmd+Enter adds, Escape cancels. */
export function NoteComposer({
  threadId,
  anchor,
  onDone,
}: {
  threadId: string;
  anchor: NoteAnchor;
  onDone: () => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const text = body.trim();

  const save = async () => {
    if (!text || saving) return;
    setSaving(true);
    const ack = await addReviewNote(threadId, anchor, text);
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

/** A note under its line. Author-less: the note is the agent's prompt, not a chat message. */
export function ReviewNoteItem({ threadId, note }: { threadId: string; note: ReviewNote }) {
  const label = noteLabel(note);
  return (
    <div className="review-note">
      <div className="review-note-head">
        <span className="mono review-note-anchor">{label}</span>
        <button
          type="button"
          className="icon-button review-note-remove"
          aria-label={`Remove review note on ${label}`}
          title="Remove note"
          onClick={() => void removeReviewNote(threadId, note.id)}
        >
          <IconTrash />
        </button>
      </div>
      <p className="review-note-body">{note.body}</p>
    </div>
  );
}
