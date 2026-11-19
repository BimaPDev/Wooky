import { FLEET_LIMITS } from "@age/contracts";
import { useRef, useState } from "react";
import { sendReviewNotes } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { isBusy, reviewBarLabel, sendHint, sendLabel } from "./notes.ts";

/** Foot of the changes panel while a thread has review notes: count, optional message, send. */
export function ReviewBar({ threadId, count }: { threadId: string; count: number }) {
  const busy = useStore((state) => isBusy(state.model.threads[threadId]?.status ?? "idle"));
  const [extra, setExtra] = useState("");
  const [sending, setSending] = useState(false);
  // A ref, not state: a double Enter in the same tick must send once.
  const inFlight = useRef(false);

  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const ack = await sendReviewNotes(threadId, extra.trim());
      if (ack) setExtra("");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const status = sending ? "Sending the notes." : sendHint(busy);

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
        <p className="review-bar-status" aria-live="polite">
          <span className="review-bar-label">{reviewBarLabel(count)}</span>
          {status ? <span className="review-bar-hint">{status}</span> : null}
        </p>
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
    </form>
  );
}
