/** A2 will replace this with syncNow(projectId) from the sync engine. */
export type SyncNow = (projectId: string) => Promise<void>;

export const noopSyncNow: SyncNow = async () => {};
