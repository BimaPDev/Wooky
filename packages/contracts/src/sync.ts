import { z } from "zod";
import { Id, IsoTime } from "./model.ts";
import { DeviceId } from "./remote.ts";

export const SyncCategories = z
  .object({
    files: z.boolean().default(true),
    threads: z.boolean().default(true),
    settings: z.boolean().default(true),
    themes: z.boolean().default(true),
    ignoredFiles: z.boolean().default(false),
  })
  .default({
    files: true,
    threads: true,
    settings: true,
    themes: true,
    ignoredFiles: false,
  });
export type SyncCategories = z.infer<typeof SyncCategories>;

export const SyncRetention = z
  .object({
    keepDays: z.number().int().nonnegative().default(30),
    keepMin: z.number().int().nonnegative().default(50),
  })
  .default({ keepDays: 30, keepMin: 50 });
export type SyncRetention = z.infer<typeof SyncRetention>;

export const SyncSettings = z
  .object({
    enabled: z.boolean().default(false),
    categories: SyncCategories,
    /** File scan interval. Turns also snapshot when they finish. */
    intervalSec: z.number().int().min(5).max(3600).default(30),
    retention: SyncRetention,
    peers: z.array(DeviceId).default([]),
    /** projectId → deviceId → absolute path on that device. */
    projectMap: z.record(z.string(), z.record(DeviceId, z.string())).default({}),
  })
  .default({
    enabled: false,
    categories: {
      files: true,
      threads: true,
      settings: true,
      themes: true,
      ignoredFiles: false,
    },
    intervalSec: 30,
    retention: { keepDays: 30, keepMin: 50 },
    peers: [],
    projectMap: {},
  });
export type SyncSettings = z.infer<typeof SyncSettings>;

export const SnapshotKind = z.enum(["files", "thread", "settings", "themes"]);
export type SnapshotKind = z.infer<typeof SnapshotKind>;

export const SnapshotReason = z.enum([
  "interval",
  "turn",
  "before-apply",
  "manual",
  "revert",
  "incoming",
]);
export type SnapshotReason = z.infer<typeof SnapshotReason>;

export const SnapshotSummary = z.object({
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type SnapshotSummary = z.infer<typeof SnapshotSummary>;

/** `id` is the shadow-repo commit sha, or a uuid for non-file snapshots. */
export const Snapshot = z.object({
  id: z.string().min(1),
  kind: SnapshotKind,
  projectId: Id.nullable(),
  threadId: Id.nullable(),
  deviceId: DeviceId,
  reason: SnapshotReason,
  createdAt: IsoTime,
  summary: SnapshotSummary.nullable(),
  parentId: z.string().min(1).nullable(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const SyncPeerState = z.enum(["idle", "syncing", "offline", "error"]);
export type SyncPeerState = z.infer<typeof SyncPeerState>;

export const SyncPeerStatus = z.object({
  deviceId: DeviceId,
  name: z.string().min(1),
  state: SyncPeerState,
  lastSyncAt: IsoTime.nullable(),
  error: z.string().nullable(),
});
export type SyncPeerStatus = z.infer<typeof SyncPeerStatus>;

export const SyncConflict = z.object({
  id: z.string().min(1),
  projectId: Id,
  peerDeviceId: DeviceId,
  /** Snapshot id of the local side. */
  mine: z.string().min(1),
  /** Snapshot id of the peer side. */
  theirs: z.string().min(1),
  base: z.string().min(1).nullable(),
  paths: z.array(z.string()),
  createdAt: IsoTime,
});
export type SyncConflict = z.infer<typeof SyncConflict>;

/** `both` keeps the peer's files with a `.theirs` suffix. */
export const ConflictResolution = z.enum(["mine", "theirs", "both"]);
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const SyncStatus = z.object({
  enabled: z.boolean(),
  peers: z.array(SyncPeerStatus),
  conflicts: z.array(SyncConflict),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

export const SyncPush = z.discriminatedUnion("kind", [
  SyncStatus.extend({
    push: z.literal("sync"),
    kind: z.literal("status"),
  }),
  z.object({
    push: z.literal("sync"),
    kind: z.literal("snapshot"),
    snapshot: Snapshot,
  }),
  z.object({
    push: z.literal("sync"),
    kind: z.literal("conflict"),
    conflict: SyncConflict,
  }),
]);
export type SyncPush = z.infer<typeof SyncPush>;
