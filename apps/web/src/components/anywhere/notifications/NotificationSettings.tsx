import {
  setNotifyPref,
  useNotifyPermission,
  useNotifyPrefs,
  type NotifyPrefs,
} from "../../../state/notifications.ts";

const rows: { key: keyof NotifyPrefs; title: string; description: string }[] = [
  {
    key: "finished",
    title: "A turn finishes",
    description: "When an agent finishes or fails a turn while you are elsewhere.",
  },
  {
    key: "needsInput",
    title: "An agent needs you",
    description: "When an approval or a question is waiting.",
  },
  {
    key: "workerReports",
    title: "A worker reports",
    description: "When a fleet worker sends its summary to the coordinator.",
  },
  {
    key: "sound",
    title: "Play a sound",
    description: "A short chime with each notification.",
  },
];

/** Notification toggles for this device. Stored in this browser, not in the shared settings. */
export function NotificationSettings() {
  const prefs = useNotifyPrefs();
  const permission = useNotifyPermission((state) => state.permission);
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Notifications</h3>
      </div>
      <div className="settings-card">
        {rows.map((row) => (
          <div key={row.key} className="setting-row">
            <div className="setting-copy">
              <p className="setting-title">{row.title}</p>
              <p className="setting-desc">{row.description}</p>
            </div>
            <div className="setting-control">
              <button
                type="button"
                role="switch"
                aria-checked={prefs[row.key]}
                aria-label={row.title}
                className={prefs[row.key] ? "toggle on" : "toggle"}
                disabled={row.key !== "sound" && permission === "unsupported"}
                onClick={() => void setNotifyPref(row.key, !prefs[row.key])}
              >
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>
        ))}
        {permission === "denied" ? (
          <p className="setting-desc notify-note" role="status">
            Notifications are blocked for this site. Allow them in your browser settings, then
            switch a toggle on again.
          </p>
        ) : null}
        {permission === "unsupported" ? (
          <p className="setting-desc notify-note" role="status">
            This browser cannot show notifications.
          </p>
        ) : null}
        <p className="setting-desc notify-note">
          Wooky only notifies while the window is in the background or the thread is not on screen.
          These choices are kept on this device.
        </p>
      </div>
    </section>
  );
}
