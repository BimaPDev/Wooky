import { queuedPrompts } from "@age/domain";
import { memo } from "react";
import { canPromoteQueuedPrompt } from "../lib/queue-enablement.ts";
import { promoteQueuedPrompt, removeQueuedPrompt } from "../state/actions.ts";
import { useStore } from "../state/store.ts";

export const QueuedPrompts = memo(function QueuedPrompts({ threadId }: { threadId: string }) {
  const queue = useStore((state) => queuedPrompts(state.model, threadId));
  const status = useStore((state) => state.model.threads[threadId]?.status ?? "idle");
  if (queue.length === 0) return null;
  const canPromote = canPromoteQueuedPrompt(status);

  return (
    <ul className="prompt-queue" aria-label="Queued messages">
      {queue.map((entry) => (
        <li key={entry.id} className="prompt-queue-item">
          <span className="prompt-queue-text">{entry.prompt}</span>
          <span className="prompt-queue-actions">
            <button
              type="button"
              className="ghost-button small"
              aria-label={`Remove queued message: ${entry.prompt}`}
              onClick={() => void removeQueuedPrompt(threadId, entry.id)}
            >
              Remove
            </button>
            <button
              type="button"
              className="ghost-button small"
              disabled={!canPromote}
              title={canPromote ? "Send this message now" : "Wait until the agent is idle"}
              aria-label={`Send now: ${entry.prompt}`}
              onClick={() => void promoteQueuedPrompt(threadId, entry.id)}
            >
              Send now
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
});
