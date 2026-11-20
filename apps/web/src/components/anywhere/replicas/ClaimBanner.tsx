import type { SyncPeerProject, Thread } from "@wooky/contracts";
import { useEffect, useState } from "react";
import { confirm, dispatch, selectThread } from "../../../state/actions.ts";
import {
  recordClaimAttempt,
  replicaKey,
  useAnywhereHistory,
} from "../../../state/anywhere-history.ts";
import { useStore } from "../../../state/store.ts";
import { claimView, resolveLocalProject } from "./helpers.ts";
import { MapProject } from "../mapping/MapProject.tsx";
import { peerProjectOf } from "../mapping/mapping.ts";

export function ClaimBanner({
  deviceId,
  thread,
  device,
}: {
  deviceId: string;
  thread: Thread;
  device: string;
}) {
  const target = { deviceId, threadId: thread.id };
  const model = useStore((state) => state.model);
  const projectMap = useStore((state) => state.deviceSettings?.sync.projectMap);
  const syncEnabled = useStore((state) => state.deviceSettings?.sync.enabled);
  const localDeviceId = useAnywhereHistory((state) => state.localDevice?.deviceId ?? null);
  const failure = useAnywhereHistory((state) => state.claimFailures[replicaKey(target)]);
  const [started, setStarted] = useState(false);

  const view = claimView({
    ownerDeviceId: deviceId,
    ownerThreadId: thread.id,
    model,
    failure,
  });
  const syncStatus = useAnywhereHistory((state) => state.syncStatus);
  const listed = peerProjectOf(syncStatus, deviceId, thread.projectId);
  // The peer's listing says which local project it is mapped to; without one, the settings map
  // (and a project with the same id) still apply.
  const localProject =
    (listed?.mappedTo ? model.projects[listed.mappedTo] : undefined) ??
    resolveLocalProject(thread.projectId, model.projects, projectMap ?? {}, localDeviceId);
  // A peer that sends no project list can still be mapped by hand, under the id its thread carries.
  const unmapped: SyncPeerProject = listed ?? {
    id: thread.projectId,
    sharedId: thread.projectId,
    name: "",
    folder: "",
    remote: null,
    branch: null,
    mappedTo: null,
    suggestion: null,
  };
  const projectName = listed?.name || listed?.folder || "this project";
  const doneThreadId = view.kind === "done" ? view.threadId : null;

  // sync: store navigation opens the new local thread once a claim started here has landed
  useEffect(() => {
    if (started && doneThreadId) selectThread(doneThreadId);
  }, [started, doneThreadId]);

  const claim = async (force: boolean) => {
    if (!localProject) return;
    const claimId = crypto.randomUUID();
    recordClaimAttempt(target, claimId);
    setStarted(true);
    const ack = await dispatch(
      {
        type: "thread.claim",
        ownerDeviceId: deviceId,
        ownerThreadId: thread.id,
        projectId: localProject.id,
        force,
      },
      claimId,
    );
    if (!ack) setStarted(false);
  };

  const forceMove = () =>
    confirm({
      title: "Force move?",
      body: `The agent on ${device} is busy. Moving now stops its running turn, and anything it has not finished is lost.`,
      confirmLabel: "Force move",
      onConfirm: () => void claim(true),
    });

  const blocker = !localProject
    ? `${projectName === "this project" ? "This project" : projectName} is not mapped on this device. Pick the local project it is, or add its folder.`
    : syncEnabled === false
      ? "Turn on sync in Settings, Anywhere. Files have to arrive before the conversation moves."
      : null;

  return (
    <div className="claim-banner" role="status">
      {view.kind === "ready" ? (
        <>
          <span className="claim-copy">
            This thread runs on <strong>{device}</strong>.
            {blocker ? <span className="muted"> {blocker}</span> : null}
          </span>
          {!localProject ? <MapProject project={unmapped} /> : null}
          <button
            type="button"
            className="button primary"
            disabled={blocker !== null}
            onClick={() => void claim(false)}
          >
            Continue on this device
          </button>
        </>
      ) : null}
      {view.kind === "pending" ? (
        <>
          <span className="claim-copy">Moving… syncing files, then the conversation.</span>
          <button type="button" className="button" disabled>
            Moving…
          </button>
        </>
      ) : null}
      {view.kind === "failed" ? (
        <>
          <span className="claim-copy claim-failed" role="alert">
            Could not move this thread: {view.reason}
            {view.canForce ? (
              <span className="muted"> Force move stops the running turn on {device}.</span>
            ) : null}
          </span>
          {view.canForce ? (
            <button type="button" className="button danger" onClick={forceMove}>
              Force move
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={blocker !== null}
              onClick={() => void claim(false)}
            >
              Try again
            </button>
          )}
        </>
      ) : null}
      {view.kind === "done" ? (
        <>
          <span className="claim-copy">This thread now continues on this device.</span>
          <button type="button" className="button" onClick={() => selectThread(view.threadId)}>
            Open it
          </button>
        </>
      ) : null}
    </div>
  );
}
