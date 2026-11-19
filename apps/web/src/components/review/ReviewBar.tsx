import { FLEET_LIMITS } from "@age/contracts";
import { useState } from "react";
import { sendReviewNotes } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { isBusy, reviewBarLabel, sendHint, sendLabel } from "./notes.ts";

/** Foot of the changes panel while a thread has review notes: count, optional message, send. */
export function ReviewBar({ threadId, count }: { threadId: string; count: number }) {
  const busy = useStore((state) => isBusy(state.model.threads[threadId]?.status ?? "idle"));
  const [extra, setExtra] = useState("");
  const [sending, setSending] = useState(false);
  const hint = sendHint(busy);

  const send = async () => {
    if (sending) return;
    setSending(true);
    const ack = await sendReviewNotes(threadId, extra.trim());
    setSending(false);
    if (ack) setExtra("");
  };

  return (
    <form
      className="review-bar"
      aria-label="Review notes"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="review-bar-head">
        <span className="review-bar-label">{reviewBarLabel(count)}</span>
        <button type="submit" className="button primary" disabled={sending}>
          {sendLabel(busy)}
        </button>
      </div>
      <input
        type="text"
        className="review-bar-extra"
        maxLength={FLEET_LIMITS.maxReviewBody}
        value={extra}
        placeholder="Add a message for the agent (optional)"
        aria-label="Message for the agent, optional"
        onChange={(event) => setExtra(event.target.value)}
      />
      {hint ? (
        <p className="review-bar-hint" aria-live="polite">
          {hint}
        </p>
      ) : null}
    </form>
  );
}
