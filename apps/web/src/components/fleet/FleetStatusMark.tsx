import type { FleetStatus } from "@wooky/contracts";

export function FleetStatusMark({ status }: { status: FleetStatus }) {
  switch (status) {
    case "working":
      return <span className="working" role="img" aria-label="Working" />;
    case "waiting":
      return <span className="dot dot-amber" role="img" aria-label="Waiting on you" />;
    case "failed":
      return <span className="dot dot-red" role="img" aria-label="Failed" />;
    case "done":
      return <span className="dot fleet-dot-done" role="img" aria-label="Done" />;
    case "idle":
      return <span className="dot fleet-dot-idle" role="img" aria-label="Idle" />;
  }
}
