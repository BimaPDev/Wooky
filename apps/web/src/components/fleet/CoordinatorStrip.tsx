import { childrenOf } from "@wooky/domain";
import { useMemo } from "react";
import { selectThread } from "../../state/actions.ts";
import { useStore } from "../../state/store.ts";
import { FleetStatusMark } from "./FleetStatusMark.tsx";
import { selectFleetStatusById, workerCountLabel } from "./helpers.ts";

export function CoordinatorStrip({ threadId }: { threadId: string }) {
  const model = useStore((state) => state.model);
  const workers = childrenOf(model, threadId);
  const statuses = selectFleetStatusById(model);
  const waiting = useMemo(
    () => workers.filter((worker) => statuses[worker.id] === "waiting").length,
    [workers, statuses],
  );
  if (workers.length === 0) return null;

  return (
    <div className="fleet-strip" aria-label="Workers">
      <span className="fleet-strip-count">{workerCountLabel(workers.length, 0)}</span>
      {waiting > 0 ? <span className="fleet-strip-waiting">{waiting} waiting</span> : null}
      <div className="fleet-strip-list">
        {workers.map((worker) => {
          const status = statuses[worker.id] ?? "idle";
          return (
            <button
              key={worker.id}
              type="button"
              className="fleet-strip-chip"
              aria-label={`${worker.title || "Untitled thread"}, ${worker.model}`}
              onClick={() => selectThread(worker.id)}
            >
              <FleetStatusMark status={status} />
              <span className="fleet-strip-model">{worker.model}</span>
              <span className="fleet-strip-title">{worker.title || "Untitled thread"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
