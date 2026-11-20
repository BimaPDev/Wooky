import type { AgeEvent, ReplicaModel } from "@wooky/contracts";
import { applyEvents, emptyReadModel } from "./project.ts";

export function emptyReplicaModel(): ReplicaModel {
  return { replicas: {} };
}

/**
 * Fold one owner's replica events with the same reducer as the local log.
 * Only threads and turns are kept. Local projects and threads are untouched.
 */
export function applyReplicaEvents(
  model: ReplicaModel,
  ownerDeviceId: string,
  events: readonly AgeEvent[],
): ReplicaModel {
  const current = model.replicas[ownerDeviceId];
  const folded = applyEvents(
    {
      ...emptyReadModel(),
      seq: current?.seq ?? 0,
      threads: current?.threads ?? {},
      turns: current?.turns ?? {},
    },
    events,
  );
  return {
    replicas: {
      ...model.replicas,
      [ownerDeviceId]: {
        seq: folded.seq,
        threads: folded.threads,
        turns: folded.turns,
      },
    },
  };
}
