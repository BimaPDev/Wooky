import { configureThread } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { sameTarget, targetLabel, targetOf } from "./format.ts";

/** Shown while a thread runs on a fallback model, with a way back to the original. */
export function FallbackBanner({ threadId }: { threadId: string }) {
  const thread = useStore((state) => state.model.threads[threadId]);
  const providers = useStore((state) => state.providers);
  const original = thread?.failover?.original;
  if (!thread || !original || sameTarget(original, targetOf(thread))) return null;
  const busy = thread.status === "running" || thread.status === "waiting";
  const label = targetLabel(providers, original);
  return (
    <div className="fallback-banner">
      <div className="fallback-banner-inner">
        <span>Running on fallback (original: {label})</span>
        <button
          type="button"
          className="ghost-button small"
          disabled={busy}
          title={busy ? "Available when the turn ends" : `Switch back to ${label}`}
          onClick={() => void configureThread(threadId, targetOf(original))}
        >
          Switch back now
        </button>
      </div>
    </div>
  );
}
