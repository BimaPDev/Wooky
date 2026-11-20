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
  /** The name the user gave a manual snapshot, if any. */
  label: z.string().max(200).nullable().default(null),
  createdAt: IsoTime,
  summary: SnapshotSummary.nullable(),
  parentId: z.string().min(1).nullable(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const SyncPeerState = z.enum(["idle", "syncing", "offline", "error"]);
export type SyncPeerState = z.infer<typeof SyncPeerState>;

/**
 * What a peer says about one of its projects, enough to match it to a local one without hand
 * editing. Peer data is untrusted: every field is size-capped, `folder` is a bare folder name
 * (never a path) and `remote` is a normalized git remote with no credentials. None of it is ever
 * used as a path on this device.
 */
export const SharedProjectId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "not a project id")
  .refine((value) => value !== "__proto__", "not a project id");

export const PeerProjectInfo = z.object({
  /** The peer's own project id. A thread of that peer names its project by this. */
  id: SharedProjectId,
  /** The id the peer shares the project's files under (the key of `projectMap`). */
  sharedId: SharedProjectId,
  name: z.string().max(200),
  folder: z
    .string()
    .max(255)
    .refine((value) => !value.includes("/") && !value.includes("\\"), "folder is a name"),
  remote: z.string().max(500).nullable().default(null),
  branch: z.string().max(200).nullable().default(null),
});
export type PeerProjectInfo = z.infer<typeof PeerProjectInfo>;

/** A peer project as this device sees it: whether it is mapped here, and what it probably is. */
export const SyncPeerProject = PeerProjectInfo.extend({
  /** The local project it is mapped to, or null while it is not mapped on this device. */
  mappedTo: Id.nullable(),
  suggestion: z
    .object({ projectId: Id, by: z.enum(["remote", "folder"]) })
    .nullable()
    .default(null),
});
export type SyncPeerProject = z.infer<typeof SyncPeerProject>;

export const SyncPeerStatus = z.object({
  deviceId: DeviceId,
  name: z.string().min(1),
  state: SyncPeerState,
  lastSyncAt: IsoTime.nullable(),
  error: z.string().nullable(),
  /** The peer's projects. Older peers send none. */
  projects: z.array(SyncPeerProject).max(200).default([]),
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
