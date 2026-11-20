import { dismissToast, useAnywhereHistory } from "../../../state/anywhere-history.ts";

/** One transient message with an optional action, for "Restored. Backup saved — Undo". */
export function Toast() {
  const toast = useAnywhereHistory((state) => state.toast);
  if (!toast) return null;
  return (
    <div className="anywhere-toast" role="status" key={toast.id}>
      <span>{toast.text}</span>
      {toast.action ? (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            const { run } = toast.action ?? { run: () => {} };
            dismissToast();
            run();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="link-button muted" onClick={dismissToast}>
        Dismiss
      </button>
    </div>
  );
}
