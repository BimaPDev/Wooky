import type { SyncPeerProject, SyncPeerStatus, SyncStatus } from "@wooky/contracts";
import { pickFolderAsProject } from "../../../state/actions.ts";
import { backend } from "../../../state/backend.ts";
import { refreshSyncStatus } from "../../../state/environments.ts";
import { useStore } from "../../../state/store.ts";

/** Maps a peer's project to a local one (or clears it with null), then refreshes the status. */
export async function mapPeerProject(
  sharedId: string,
  localProjectId: string | null,
): Promise<boolean> {
  try {
    await backend().call("sync.projects.map", { sharedId, localProjectId });
    await refreshSyncStatus().catch(() => {});
    return true;
  } catch (error) {
    useStore.setState({
      notice: error instanceof Error ? error.message : "Could not map that project.",
    });
    return false;
  }
}

/** "Add this project": choose a folder on this machine, register it, and map the peer's project to it. */
export async function addFolderAndMap(sharedId: string): Promise<boolean> {
  const projectId = await pickFolderAsProject();
  if (!projectId) return false;
  return mapPeerProject(sharedId, projectId);
}

export function suggestionReason(by: "remote" | "folder"): string {
  return by === "remote" ? "same git remote" : "same folder name";
}

/** The peer's own listing of one of its projects, by the id its threads carry. */
export function peerProjectOf(
  status: SyncStatus | null,
  deviceId: string,
  peerProjectId: string,
): SyncPeerProject | null {
  const peer = status?.peers.find((item) => item.deviceId === deviceId);
  return peer?.projects.find((item) => item.id === peerProjectId) ?? null;
}

/** Projects a peer shares that are not mapped on this device yet. */
export function unmappedProjects(peer: Pick<SyncPeerStatus, "projects">): SyncPeerProject[] {
  return peer.projects.filter((project) => project.mappedTo === null);
}
