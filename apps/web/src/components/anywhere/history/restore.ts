import { showToast, useAnywhereHistory } from "../../../state/anywhere-history.ts";
import { restoreSnapshot } from "./rpc.ts";

const bumpTimeline = () =>
  useAnywhereHistory.setState((state) => ({ snapshotTick: state.snapshotTick + 1 }));

/**
 * Restore files from a snapshot. The server takes a backup first and returns its id, which the
 * toast's Undo restores. A refusal (an agent is working) throws with the server's message.
 */
export async function restoreFiles(
  snapshotId: string,
  paths: readonly string[] | null,
): Promise<void> {
  const { backupSnapshotId } = await restoreSnapshot(snapshotId, paths);
  bumpTimeline();
  showToast("Restored. Backup saved", {
    label: "Undo",
    run: () => void undoRestore(backupSnapshotId, paths),
  });
}

async function undoRestore(backupSnapshotId: string, paths: readonly string[] | null) {
  try {
    await restoreSnapshot(backupSnapshotId, paths);
    bumpTimeline();
    showToast("Undone. The files are back as they were");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not undo the restore.");
  }
}
