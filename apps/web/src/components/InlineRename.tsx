import { useRef, useState } from "react";

/** Text field that commits on Enter or blur and cancels on Escape. */
export function InlineRename({
  value,
  label,
  onDone,
  className = "inline-rename",
}: {
  value: string;
  label: string;
  onDone: (value: string | null) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(false);
  const finish = (next: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(next === null ? null : next.trim() || null);
  };
  return (
    <input
      className={className}
      aria-label={label}
      value={draft}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(draft);
        if (event.key === "Escape") finish(null);
      }}
    />
  );
}
