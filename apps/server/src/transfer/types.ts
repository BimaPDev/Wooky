/**
 * Brings a project's files up to date from a peer before a claim goes on. `projectId` is the
 * project's id on THIS device. `ownerDeviceId` is the peer whose files are wanted. It rejects
 * with a message the user can read when the files did not arrive.
 */
export type SyncNow = (projectId: string, ownerDeviceId?: string) => Promise<void>;
