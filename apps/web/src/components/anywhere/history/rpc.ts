import type { RpcParams } from "@wooky/contracts";
import { backend } from "../../../state/backend.ts";

export const listSnapshots = (params: RpcParams<"sync.snapshots.list">) =>
  backend().call("sync.snapshots.list", params);

export const diffSnapshot = (snapshotId: string, against?: string) =>
  backend().call("sync.snapshots.diff", against ? { snapshotId, against } : { snapshotId });

export const restoreSnapshot = (snapshotId: string, paths: readonly string[] | null) =>
  backend().call(
    "sync.snapshots.restore",
    paths ? { snapshotId, paths: [...paths] } : { snapshotId },
  );

export const createSnapshot = (projectId: string, label: string) =>
  backend().call("sync.snapshots.create", label ? { projectId, label } : { projectId });

export const resolveConflict = (
  conflictId: string,
  resolution: RpcParams<"sync.conflicts.resolve">["resolution"],
) => backend().call("sync.conflicts.resolve", { conflictId, resolution });
