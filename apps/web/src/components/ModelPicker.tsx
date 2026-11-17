import type { ProviderKind, RuntimeMode, Thread } from "@age/contracts";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { configureThread } from "../state/actions.ts";
import { useStore } from "../state/store.ts";
import { isAvailable, runtimeModes } from "./labels.ts";

/** A chip that opens the provider / model / runtime mode picker for a thread. */
export function ModelPickerButton({
  thread,
  className,
  children,
  placement = "below",
}: {
  thread: Thread;
  className: string;
  children: ReactNode;
  placement?: "below" | "above";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  // sync: document-level pointer and key listeners close the popover
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="popover-root" ref={root}>
      <button
        type="button"
        className={className}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        title="Change provider, model or mode"
        onClick={() => setOpen(!open)}
      >
        {children}
      </button>
      {open ? (
        <div className={`popover ${placement}`} id={id} role="dialog" aria-label="Agent settings">
          <ModelPicker thread={thread} />
        </div>
      ) : null}
    </div>
  );
}

function ModelPicker({ thread }: { thread: Thread }) {
  const providers = useStore((state) => state.providers);
  const running = thread.status === "running" || thread.status === "waiting";
  const current = providers.find((entry) => entry.kind === thread.provider);

  const switchProvider = (kind: ProviderKind) => {
    const provider = providers.find((entry) => entry.kind === kind);
    if (!provider || kind === thread.provider) return;
    void configureThread(thread.id, { provider: kind, model: provider.models[0]?.id ?? "" });
  };

  return (
    <div className="picker">
      <fieldset className="picker-section" disabled={running}>
        <legend>Provider</legend>
        {providers.length === 0 ? <p className="muted">Loading providers.</p> : null}
        {providers.map((provider) => (
          <label
            key={provider.kind}
            className={isAvailable(provider) ? "option" : "option disabled"}
            title={provider.problem ?? undefined}
          >
            <input
              type="radio"
              name={`provider-${thread.id}`}
              checked={provider.kind === thread.provider}
              disabled={!isAvailable(provider)}
              onChange={() => switchProvider(provider.kind)}
            />
            <span className={`provider-mark provider-${provider.kind}`} aria-hidden="true" />
            <span>{provider.label}</span>
            {provider.problem ? <span className="option-note">{provider.problem}</span> : null}
          </label>
        ))}
        <p className="picker-note">
          Switching provider hands the conversation off to a new session.
        </p>
      </fieldset>
      {current && current.models.length > 0 ? (
        <label className="picker-section field">
          <span>Model</span>
          <select
            value={thread.model}
            disabled={running}
            onChange={(event) => void configureThread(thread.id, { model: event.target.value })}
          >
            {current.models.some((model) => model.id === thread.model) ? null : (
              <option value={thread.model}>{thread.model}</option>
            )}
            {current.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <fieldset className="picker-section" disabled={running}>
        <legend>Runtime mode</legend>
        {runtimeModes.map((mode) => (
          <label key={mode.id} className="option">
            <input
              type="radio"
              name={`mode-${thread.id}`}
              checked={mode.id === thread.runtimeMode}
              onChange={() =>
                void configureThread(thread.id, { runtimeMode: mode.id as RuntimeMode })
              }
            />
            <span>{mode.label}</span>
          </label>
        ))}
      </fieldset>
      {running ? <p className="picker-note">Settings change once the current turn ends.</p> : null}
    </div>
  );
}
