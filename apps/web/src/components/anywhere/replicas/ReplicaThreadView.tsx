import type { Turn } from "@wooky/contracts";
import { deviceLabel, deviceNames, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { ThreadView } from "../../ThreadView.tsx";
import { ClaimBanner } from "./ClaimBanner.tsx";

const NO_TURNS: readonly Turn[] = [];

/** A peer device's thread, read-only, with the way to continue it here. */
export function ReplicaThreadView() {
  const target = useAnywhereHistory((state) => state.replicaView);
  return target ? (
    <ReplicaThread key={`${target.deviceId}:${target.threadId}`} {...target} />
  ) : null;
}

function ReplicaThread({ deviceId, threadId }: { deviceId: string; threadId: string }) {
  const slice = useAnywhereHistory((state) => state.replicas[deviceId]);
  const device = useAnywhereHistory((state) =>
    deviceLabel(deviceNames(state.syncStatus), deviceId),
  );
  const thread = slice?.threads[threadId];
  if (!thread) return <p className="empty-state">This thread is no longer on {device}.</p>;
  return (
    <>
      <ClaimBanner deviceId={deviceId} thread={thread} device={device} />
      <ThreadView threadId={thread.id} peerTurns={slice?.turns[thread.id] ?? NO_TURNS} />
    </>
  );
}

/** The top bar's title while a peer thread is open: "On Work Mac / Retry the uploader". */
export function ReplicaCrumb() {
  const target = useAnywhereHistory((state) => state.replicaView);
  const title = useAnywhereHistory((state) =>
    state.replicaView
      ? state.replicas[state.replicaView.deviceId]?.threads[state.replicaView.threadId]?.title
      : undefined,
  );
  const device = useAnywhereHistory((state) =>
    state.replicaView ? deviceLabel(deviceNames(state.syncStatus), state.replicaView.deviceId) : "",
  );
  if (!target) return null;
  return (
    <>
      <span className="crumb-project">On {device}</span>
      <span className="crumb-sep" aria-hidden="true">
        /
      </span>
      <span className="topbar-draft-title">{title ?? "Thread"}</span>
    </>
  );
}
