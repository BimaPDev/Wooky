import type { ReactNode } from "react";

export function SettingsBlock({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function Row({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <p className="setting-title">{title}</p>
        <p className="setting-desc">{description}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "toggle on" : "toggle"}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

export function IconAnywhere() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M2.2 8h11.6" />
      <path d="M8 2.2c1.8 1.8 2.6 3.8 2.6 5.8s-.8 4-2.6 5.8c-1.8-1.8-2.6-3.8-2.6-5.8s.8-4 2.6-5.8z" />
    </svg>
  );
}
