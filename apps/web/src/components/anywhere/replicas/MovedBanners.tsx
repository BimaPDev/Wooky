import type { ReactNode } from "react";
import { deviceLabel, deviceNames, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";

function useDeviceLabel(deviceId: string | undefined): string {
  return useAnywhereHistory((state) =>
    deviceId ? deviceLabel(deviceNames(state.syncStatus), deviceId) : "",
  );
}

/** A thread another device took over: it stays readable here and its composer is off. */
export function MovedToBanner({ threadId }: { threadId: string }) {
  const movedTo = useStore((state) => state.model.threads[threadId]?.movedTo);
  const device = useDeviceLabel(movedTo?.deviceId);
  if (!movedTo) return null;
  return (
    <div className="moved-banner" role="status">
      <span>
        <strong>Moved to {device}</strong>
        <span className="muted"> · this thread continues there and is read-only here.</span>
      </span>
    </div>
  );
}

/** Wraps the composer. A moved thread gets the banner and a disabled composer. */
export function ComposerGate({ threadId, children }: { threadId: string; children: ReactNode }) {
  const moved = useStore((state) => state.model.threads[threadId]?.movedTo !== null);
  if (!moved) return children;
  return (
    <>
      <MovedToBanner threadId={threadId} />
      <fieldset className="composer-locked" disabled>
        {children}
      </fieldset>
    </>
  );
}

/** A subtle line at the top of a thread that was moved here from another device. */
export function ContinuedFromMarker({ threadId }: { threadId: string }) {
  const movedFrom = useStore((state) => state.model.threads[threadId]?.movedFrom);
  const device = useDeviceLabel(movedFrom?.deviceId);
  if (!movedFrom) return null;
  return <p className="continued-from">Continued from {device}</p>;
}
