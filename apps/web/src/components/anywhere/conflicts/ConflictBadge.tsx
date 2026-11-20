import { openHistory, useAnywhereHistory } from "../../../state/anywhere-history.ts";

/** In the sidebar while sync has unresolved conflicts. Opens the history of the first one. */
export function ConflictBadge() {
  const conflicts = useAnywhereHistory((state) => state.syncStatus?.conflicts);
  const first = conflicts?.[0];
  if (!conflicts || !first) return null;
  const count = conflicts.length;
  return (
    <button type="button" className="conflict-badge" onClick={() => openHistory(first.projectId)}>
      <span className="dot dot-amber" aria-hidden="true" />
      <span>
        {count} sync {count === 1 ? "conflict" : "conflicts"}
      </span>
      <span className="conflict-badge-action">Review</span>
    </button>
  );
}
