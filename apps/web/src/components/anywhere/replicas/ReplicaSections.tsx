import type { Thread } from "@wooky/contracts";
import { useMemo, useState } from "react";
import {
  deviceLabel,
  deviceNames,
  openReplicaThread,
  useAnywhereHistory,
} from "../../../state/anywhere-history.ts";
import { IconChevron } from "../../Icons.tsx";
import { peerThreads } from "./helpers.ts";

/** One collapsible section per peer device: "On Work Mac", its threads read-only. */
export function ReplicaSections() {
  const replicas = useAnywhereHistory((state) => state.replicas);
  const status = useAnywhereHistory((state) => state.syncStatus);
  const sections = useMemo(() => {
    const names = deviceNames(status);
    return Object.entries(replicas)
      .map(([deviceId, slice]) => ({
        deviceId,
        name: deviceLabel(names, deviceId),
        offline: status?.peers.find((peer) => peer.deviceId === deviceId)?.state === "offline",
        threads: peerThreads(slice),
      }))
      .filter((section) => section.threads.length > 0)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }, [replicas, status]);
  return sections.map((section) => <ReplicaSection key={section.deviceId} {...section} />);
}

function ReplicaSection({
  deviceId,
  name,
  offline,
  threads,
}: {
  deviceId: string;
  name: string;
  offline: boolean;
  threads: Thread[];
}) {
  const [open, setOpen] = useState(true);
  const active = useAnywhereHistory((state) =>
    state.replicaView?.deviceId === deviceId ? state.replicaView.threadId : null,
  );
  return (
    <section className="sidebar-replicas" aria-label={`On ${name}`}>
      <button
        type="button"
        className="sidebar-section-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>On {name}</span>
        {offline ? <span className="sidebar-section-count">offline</span> : null}
        <span className="sidebar-section-count">{threads.length}</span>
        <IconChevron open={open} />
      </button>
      {open ? (
        <ul className="thread-list">
          {threads.map((thread) => (
            <li
              key={thread.id}
              className={thread.id === active ? "thread-row active" : "thread-row"}
            >
              <button
                type="button"
                className="thread-button"
                aria-current={thread.id === active ? "page" : undefined}
                onClick={() => openReplicaThread({ deviceId, threadId: thread.id })}
              >
                <span className="thread-top">
                  <span className="thread-title">{thread.title || "Untitled thread"}</span>
                </span>
                <span className="thread-meta">
                  <PeerStatus status={thread.status} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PeerStatus({ status }: { status: Thread["status"] }) {
  switch (status) {
    case "running":
      return <span className="working" role="img" aria-label="Working" />;
    case "waiting":
      return <span className="dot dot-amber" role="img" aria-label="Waiting for you" />;
    case "error":
      return <span className="dot dot-red" role="img" aria-label="Error" />;
    case "idle":
      return null;
  }
}
