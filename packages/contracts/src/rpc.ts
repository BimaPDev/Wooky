import { z } from "zod";
import {
  AppearanceTheme,
  AppearanceThemeSummary,
  DeviceSettings,
  DeviceSettingsPatch,
  ThemeImportFormat,
} from "./appearance.ts";
import {
  BrainEntry,
  BrainInboxItem,
  BrainScope,
  BrainSearchHit,
  BrainTier,
  BrainTreeNode,
  BrainUri,
  BrainWriteFrontmatter,
} from "./brain.ts";
import { ProviderCooldown } from "./failover.ts";
import { Command, ThreadSpawnParams } from "./commands.ts";
import { AgeEvent } from "./events.ts";
import {
  DiffStat,
  FLEET_LIMITS,
  FileDiff,
  FleetRow,
  FleetStatus,
  Id,
  IsoTime,
  Project,
  ProviderKind,
  ProviderStatus,
  PullRequest,
  ReviewNote,
  Thread,
  ThreadGroup,
  Turn,
} from "./model.ts";
import {
  DeviceId,
  DeviceInfo,
  Environment,
  PairingCode,
  PairingCodeText,
  PairedDeviceView,
  RemoteConnection,
  TailscaleStatus,
} from "./remote.ts";
import {
  ConflictResolution,
  SharedProjectId,
  Snapshot,
  SnapshotKind,
  SyncPush,
  SyncStatus,
} from "./sync.ts";
import { TerminalInfo, TerminalPush, TerminalSessionId, TerminalSize } from "./terminal.ts";
import { ProviderLimits, UsageHistoryParams, UsageHistoryResult } from "./usage.ts";

/**
 * Wire protocol over a single WebSocket at /ws.
 * client -> server: RpcRequest
 * server -> client: RpcResponse | RpcPush
 * The server is authoritative. Clients send commands and render pushed events.
 */

/** Bytes per attached file. Base64 of this fits the socket's 8 MB frame limit. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_MAX_BASE64 = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

export const Attachment = z.object({
  id: Id,
  name: z.string(),
  /** Absolute path on the server's machine. Agents read the file from here. */
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof Attachment>;

export const PendingClaim = z.object({
  claimId: Id,
  ownerDeviceId: DeviceId,
  ownerThreadId: Id,
  projectId: Id,
  at: IsoTime,
});
export type PendingClaim = z.infer<typeof PendingClaim>;

export const ReadModel = z.object({
  /** Sequence of the last event applied to this snapshot. */
  seq: z.number().int().nonnegative(),
  projects: z.record(z.string(), Project),
  threads: z.record(z.string(), Thread),
  /** Turns per thread, oldest first. */
  turns: z.record(z.string(), z.array(Turn)),
  cooldowns: z.record(z.string(), ProviderCooldown).default({}),
  /** Fan-out and orchestrated groups. Absent on snapshots from before fleet. */
  groups: z.record(z.string(), ThreadGroup).default({}),
  /** Review notes keyed by thread, insertion order. Absent on older snapshots. */
  reviewNotes: z.record(z.string(), z.array(ReviewNote)).default({}),
  /** In-flight "continue on this device" requests. Absent on older snapshots. */
  pendingClaims: z.record(z.string(), PendingClaim).default({}),
});
export type ReadModel = z.infer<typeof ReadModel>;

/**
 * Thread replicas live beside the local read model. `seq` is the last replica
 * event applied for that owner, so a replayed overlap is ignored.
 */
export const ReplicaSlice = z.object({
  seq: z.number().int().nonnegative().default(0),
  threads: z.record(z.string(), Thread).default({}),
  turns: z.record(z.string(), z.array(Turn)).default({}),
});
export type ReplicaSlice = z.infer<typeof ReplicaSlice>;

export const ReplicaModel = z.object({
  replicas: z.record(DeviceId, ReplicaSlice).default({}),
});
export type ReplicaModel = z.infer<typeof ReplicaModel>;

/** What `git.mergePreview` returns before a merge is attempted. */
export const MergePreview = z.object({
  targetBranch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
  conflicts: z.array(z.string()),
});
export type MergePreview = z.infer<typeof MergePreview>;

/** What `agents.result` returns for one worker. */
export const AgentResult = z.object({
  status: FleetStatus,
  summary: z.string().max(FLEET_LIMITS.maxReportSummary),
  diffStat: DiffStat.optional(),
  worktreePath: z.string().optional(),
});
export type AgentResult = z.infer<typeof AgentResult>;

export const WorkspaceEntry = z.object({
  /** Relative to the thread's workspace, with forward slashes. */
  path: z.string(),
  kind: z.enum(["file", "dir"]),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

const AgentsAuthFields = {
  agentToken: z.string().min(1).optional(),
};

export const RpcMethods = {
  /** Record a command. Ack means the intent was saved, not that the work finished. */
  dispatch: {
    params: Command,
    result: z.object({ accepted: z.boolean(), duplicate: z.boolean(), seq: z.number().int() }),
  },
  /** Full read model. Clients call this once, then subscribe from its seq. */
  snapshot: { params: z.object({}), result: ReadModel },
  /** Stream events with seq > fromSeq (replays history first, then live). */
  subscribe: {
    params: z.object({ fromSeq: z.number().int().nonnegative() }),
    result: z.object({ replayed: z.number().int().nonnegative() }),
  },
  "providers.list": { params: z.object({}), result: z.array(ProviderStatus) },
  /** Open the provider's fixed sign-in command in a real terminal. The client names the provider, never the command. */
  "providers.signIn": {
    params: z.object({ provider: ProviderKind.exclude(["demo"]) }),
    result: z.object({ opened: z.literal(true), command: z.string() }),
  },
  /** Diff of the workspace for a thread: whole thread, or a single turn. */
  "git.diff": {
    params: z.object({ threadId: Id, turnId: Id.optional() }),
    result: z.array(FileDiff),
  },
  "fs.pickable": {
    /** Suggest directories for "add project" (home children, recent roots). */
    params: z.object({ query: z.string().optional() }),
    result: z.array(z.object({ path: z.string(), isGitRepo: z.boolean() })),
  },
  /** Open the operating system's folder chooser on the server's machine. */
  "fs.pickFolder": {
    params: z.object({ title: z.string().max(80).optional() }),
    result: z.object({ path: z.string().nullable(), supported: z.boolean() }),
  },
  /** Files and directories in a thread's workspace matching query, best first. */
  "fs.searchEntries": {
    params: z.object({
      threadId: Id,
      query: z.string(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.array(WorkspaceEntry),
  },
  /** The id of the hidden "No project" project, created on first use. */
  "projects.scratch": { params: z.object({}), result: z.object({ projectId: Id }) },
  "settings.get": { params: z.object({}), result: DeviceSettings },
  "settings.put": {
    params: z.object({ settings: DeviceSettingsPatch }),
    result: DeviceSettings,
  },
  "themes.list": {
    params: z.object({}),
    result: z.object({
      themesDir: z.string(),
      activeThemeId: z.string(),
      themes: z.array(AppearanceThemeSummary),
    }),
  },
  "themes.get": {
    params: z.object({ id: z.string() }),
    result: AppearanceTheme,
  },
  "themes.put": {
    params: z.object({ theme: AppearanceTheme }),
    result: AppearanceTheme,
  },
  "themes.delete": {
    params: z.object({ id: z.string() }),
    result: z.object({ deleted: z.boolean() }),
  },
  /**
   * Import Wooky theme JSON, a t3code theme JSON (version, name, appearance,
   * colors with canvas and surface, optional variants and css), or a raw SVG
   * file that becomes a wallpaper theme. The server classifies the text.
   */
  "themes.import": {
    params: z.object({
      text: z.string().max(7_000_000),
      filename: z.string().max(255).optional(),
      activate: z.boolean().optional(),
    }),
    result: z.object({ theme: AppearanceTheme, format: ThemeImportFormat }),
  },
  "themes.activate": {
    params: z.object({ id: z.string() }),
    result: DeviceSettings,
  },
  /** Start a local shell in cwd (project/worktree root). One session per call. */
  "terminal.open": {
    params: z.object({
      cwd: z.string().min(1).optional(),
      cols: z.number().int().positive().optional(),
      rows: z.number().int().positive().optional(),
      projectId: Id.optional(),
      scriptId: Id.optional(),
      size: TerminalSize.optional(),
    }),
    result: z.object({
      sessionId: TerminalSessionId,
      shell: z.string(),
      /** CRLF on Windows shells, LF elsewhere. Absent on older servers; clients use LF. */
      lineEnding: z.enum(["\n", "\r\n"]).optional(),
      title: z.string().optional(),
      cwd: z.string().optional(),
      pty: z.boolean().optional(),
      createdAt: z.string().optional(),
      exited: z.boolean().optional(),
      projectId: Id.nullable().optional(),
      scriptId: Id.nullable().optional(),
    }),
  },
  "terminal.list": { params: z.object({}), result: z.array(TerminalInfo) },
  /** Reattach. The server then pushes a `replay` of the buffered scrollback. */
  "terminal.attach": {
    params: z.object({ sessionId: TerminalSessionId }),
    result: TerminalInfo,
  },
  "terminal.write": {
    params: z.object({ sessionId: TerminalSessionId, data: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  "terminal.resize": {
    params: z.object({
      sessionId: TerminalSessionId,
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  "terminal.close": {
    params: z.object({ sessionId: TerminalSessionId }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Live plan-limit meters per provider (Claude / Codex). Cached briefly server-side. */
  "usage.limits": {
    params: z.object({ refresh: z.boolean().optional() }),
    result: z.array(ProviderLimits),
  },
  /** Aggregated local history. Not the plan-limit meters. */
  "usage.history": {
    params: UsageHistoryParams,
    result: UsageHistoryResult,
  },
  /**
   * Every thread the server knows, for the fleet board and `wooky agents list`.
   * The same rows are `fleetRows` in `@wooky/domain`; the RPC exists for the CLI.
   */
  "fleet.overview": {
    params: z.object({}),
    result: z.array(FleetRow),
  },
  /** How a thread's worktree compares with the project's current branch. */
  "git.mergePreview": {
    params: z.object({ threadId: Id }),
    result: MergePreview,
  },
  /** Save a file the user attached in the composer. The prompt then names its path. */
  "attachments.put": {
    params: z.object({
      name: z.string().min(1).max(255),
      dataBase64: z.string().max(ATTACHMENT_MAX_BASE64),
    }),
    result: Attachment,
  },
  /** Delete an attachment the user removed before sending. */
  "attachments.remove": {
    params: z.object({ id: Id }),
    result: z.object({ removed: z.boolean() }),
  },
  /** `wooky agents spawn`. Same fields as `thread.spawn`, without a command id. */
  "agents.spawn": {
    params: ThreadSpawnParams.extend({
      ...AgentsAuthFields,
      idempotencyKey: z.string().min(1).max(128).optional(),
    }),
    result: z.object({ threadId: Id }),
  },
  /** `wooky agents list`. Overview rows whose parent is this coordinator. */
  "agents.list": {
    params: z.object({ parentThreadId: Id.optional(), ...AgentsAuthFields }),
    result: z.array(FleetRow),
  },
  /** `wooky agents wait`. Blocks until each thread is done or failed, or the timeout fires. */
  "agents.wait": {
    params: z.object({
      threadIds: z.array(Id),
      timeoutMs: z.number().int().min(1000).max(FLEET_LIMITS.maxAgentsWaitMs),
      ...AgentsAuthFields,
    }),
    result: z.object({
      finished: z.array(Id),
      pending: z.array(Id),
    }),
  },
  /** `wooky agents result`. Summary of the worker's latest report. */
  "agents.result": {
    params: z.object({ threadId: Id, ...AgentsAuthFields }),
    result: AgentResult,
  },
  "device.info": { params: z.object({}), result: DeviceInfo },
  "device.rename": {
    params: z.object({ name: z.string().min(1) }),
    result: DeviceInfo,
  },
  "remote.tailscaleStatus": { params: z.object({}), result: TailscaleStatus },
  /** The port this server listens on, and whether `--port` (or WOOKY_PORT) fixed it. */
  "remote.listenInfo": {
    params: z.object({}),
    result: z.object({ port: z.number().int().nonnegative(), portExplicit: z.boolean() }),
  },
  "remote.pairingCode.create": { params: z.object({}), result: PairingCode },
  "remote.devices.list": { params: z.object({}), result: z.array(PairedDeviceView) },
  "remote.devices.revoke": {
    params: z.object({ deviceId: DeviceId }),
    result: z.object({ ok: z.literal(true) }),
  },
  "remote.devices.rename": {
    params: z.object({ deviceId: DeviceId, name: z.string().min(1) }),
    result: PairedDeviceView,
  },
  /** This server pairs itself with another Wooky and stores the token locally. */
  "remote.join": {
    params: z.object({
      connection: RemoteConnection,
      code: PairingCodeText,
      label: z.string().min(1).optional(),
    }),
    result: z.object({
      environment: Environment,
      host: DeviceInfo,
    }),
  },
  /** Loopback only. The local UI opens a websocket to the paired environment. */
  "remote.connectInfo": {
    params: z.object({ environmentId: z.string().min(1) }),
    result: z.object({
      wsUrl: z.string().min(1),
      token: z.string().min(1),
    }),
  },
  "sync.status": { params: z.object({}), result: SyncStatus },
  "sync.now": {
    params: z.object({ projectId: Id.optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  "sync.snapshots.list": {
    params: z.object({
      kind: SnapshotKind.optional(),
      projectId: Id.optional(),
      threadId: Id.optional(),
      limit: z.number().int().positive().max(500).optional(),
      before: z.string().min(1).optional(),
    }),
    result: z.array(Snapshot),
  },
  "sync.snapshots.diff": {
    params: z.object({
      snapshotId: z.string().min(1),
      against: z.union([z.string().min(1), z.literal("working")]).optional(),
    }),
    result: z.array(FileDiff),
  },
  "sync.snapshots.restore": {
    params: z.object({
      snapshotId: z.string().min(1),
      paths: z.array(z.string()).optional(),
    }),
    result: z.object({ backupSnapshotId: z.string().min(1) }),
  },
  "sync.snapshots.create": {
    params: z.object({
      projectId: Id,
      label: z.string().min(1).optional(),
    }),
    /** `unchanged`: no files changed since the last snapshot (a label is kept as a marker). */
    result: Snapshot.extend({ unchanged: z.boolean().default(false) }),
  },
  "sync.conflicts.resolve": {
    params: z.object({ conflictId: z.string().min(1), resolution: ConflictResolution }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Maps a peer's project to a local project (`localProjectId`), or clears the mapping (null).
   * `sharedId` is the id the peer shares the project under. This device only; the local project
   * must already be registered here.
   */
  "sync.projects.map": {
    params: z.object({ sharedId: SharedProjectId, localProjectId: Id.nullable() }),
    result: z.object({ ok: z.literal(true) }),
  },
  "sync.replicas": { params: z.object({}), result: ReplicaModel },
  "scripts.run": {
    params: z.object({
      projectId: Id,
      scriptId: Id,
      threadId: Id.optional(),
      /** Close a live session for this script and start a fresh one. */
      restart: z.boolean().optional(),
    }),
    result: TerminalInfo,
  },
  /** Gitignored top-level entries in the project root, for the shared-files picker. */
  "scripts.suggestSharedPaths": {
    params: z.object({ projectId: Id }),
    result: z.array(z.string()),
  },
  "git.status": {
    params: z.object({ threadId: Id }),
    result: z.object({
      branch: z.string(),
      upstream: z.string().nullable(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      dirty: z.boolean(),
      hasRemote: z.boolean(),
      ghAvailable: z.boolean(),
      ghAuthed: z.boolean(),
    }),
  },
  "git.commit": {
    params: z.object({ threadId: Id, message: z.string().min(1) }),
    result: z.object({ sha: z.string().min(1) }),
  },
  "git.push": {
    params: z.object({ threadId: Id, setUpstream: z.boolean().optional() }),
    result: z.object({ ok: z.literal(true), remoteUrl: z.string().min(1) }),
  },
  "git.pr.create": {
    params: z.object({
      threadId: Id,
      title: z.string().min(1),
      body: z.string(),
      base: z.string().min(1).optional(),
      draft: z.boolean().optional(),
    }),
    result: z.object({ url: z.string().min(1), number: z.number().int().positive() }),
  },
  "git.pr.status": {
    params: z.object({ threadId: Id }),
    result: PullRequest.nullable(),
  },
  "brain.list": {
    params: z.object({
      uri: BrainUri,
      includeArchived: z.boolean().optional(),
      ...AgentsAuthFields,
    }),
    result: z.array(BrainTreeNode),
  },
  "brain.read": {
    params: z.object({
      uri: BrainUri,
      tier: BrainTier,
      ...AgentsAuthFields,
    }),
    result: BrainEntry,
  },
  "brain.search": {
    params: z.object({
      query: z.string(),
      scopes: z.array(BrainScope),
      pathPrefix: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeArchived: z.boolean().optional(),
      ...AgentsAuthFields,
    }),
    result: z.array(BrainSearchHit),
  },
  "brain.write": {
    params: z.object({
      uri: BrainUri,
      frontmatter: BrainWriteFrontmatter,
      body: z.string(),
      /** A stamp: update only if it matches. `null`: create only, the file must not exist. */
      expectedUpdatedAt: z.string().nullable().optional(),
      /** Downgrade only: a global write goes to the inbox even for a user. Never raises privilege. */
      propose: z.boolean().optional(),
      ...AgentsAuthFields,
    }),
    result: z.object({
      uri: BrainUri,
      updatedAt: z.iso.datetime(),
      created: z.boolean(),
      queued: z.boolean(),
      proposalId: z.string().min(1).optional(),
      message: z.string().optional(),
    }),
  },
  "brain.archive": {
    params: z.object({
      uri: BrainUri,
      ...AgentsAuthFields,
    }),
    result: z.object({
      uri: BrainUri,
      updatedAt: z.iso.datetime(),
      created: z.boolean(),
    }),
  },
  "brain.remove": {
    params: z.object({
      uri: BrainUri,
      ...AgentsAuthFields,
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  "brain.reindex": {
    params: z.object({
      scope: BrainScope.optional(),
      ...AgentsAuthFields,
    }),
    result: z.object({
      added: z.number().int().nonnegative(),
      updated: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
      scopes: z.number().int().nonnegative(),
      truncated: z.boolean().optional(),
    }),
  },
  "brain.inbox.list": {
    params: z.object({ ...AgentsAuthFields }),
    result: z.array(BrainInboxItem),
  },
  "brain.inbox.approve": {
    params: z.object({
      id: z.string().min(1),
      /** The user's edits, applied in the same step as the approval. */
      edits: z.object({ frontmatter: BrainWriteFrontmatter, body: z.string() }).optional(),
      ...AgentsAuthFields,
    }),
    result: z.object({
      id: z.string().min(1),
      uri: BrainUri,
      updatedAt: z.iso.datetime(),
      created: z.boolean(),
    }),
  },
  "brain.inbox.reject": {
    params: z.object({
      id: z.string().min(1),
      ...AgentsAuthFields,
    }),
    result: z.object({
      id: z.string().min(1),
      ok: z.literal(true),
    }),
  },
  "brain.claim": {
    params: z.object({
      target: z.string().min(1).max(200),
      note: z.string().max(2048).optional(),
      ...AgentsAuthFields,
    }),
    result: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("claimed"),
        claimId: z.string().min(1),
        expiresAt: IsoTime,
      }),
      z.object({
        status: z.literal("held"),
        holder: z.object({
          threadId: Id,
          agent: z.string().min(1),
          target: z.string().min(1),
          note: z.string(),
          expiresAt: IsoTime,
        }),
      }),
    ]),
  },
  "brain.release": {
    params: z.object({
      claimId: z.string().min(1).max(128),
      ...AgentsAuthFields,
    }),
    result: z.object({
      released: z.boolean(),
    }),
  },
  "brain.handoff": {
    params: z.object({
      summary: z.string().min(1).max(2048),
      toThreadId: Id.optional(),
      ...AgentsAuthFields,
    }),
    result: z.object({
      handoffId: z.string().min(1),
    }),
  },
  "brain.finding": {
    params: z.object({
      text: z.string().min(1).max(2048),
      ...AgentsAuthFields,
    }),
    result: z.object({
      findingId: z.string().min(1),
    }),
  },
} as const;

export type RpcMethod = keyof typeof RpcMethods;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RpcMethods)[M]["params"]>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RpcMethods)[M]["result"]>;

export const RpcRequest = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z.unknown(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcError = z.object({
  code: z.enum(["bad_request", "not_found", "conflict", "unavailable", "forbidden", "internal"]),
  message: z.string(),
});
export type RpcError = z.infer<typeof RpcError>;

export const RpcResponse = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: RpcError }),
]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export const RpcEventPush = z.object({
  push: z.literal("event"),
  event: AgeEvent,
});
export type RpcEventPush = z.infer<typeof RpcEventPush>;

/** Theme or settings change made outside this client, for example from the CLI. */
export const ThemesPush = z.object({
  push: z.literal("themes"),
  activeThemeId: z.string(),
  changedIds: z.array(z.string()),
});
export type ThemesPush = z.infer<typeof ThemesPush>;

export const RpcPush = z.union([RpcEventPush, TerminalPush, ThemesPush, SyncPush]);
export type RpcPush = z.infer<typeof RpcPush>;

export const ServerMessage = z.union([RpcResponse, RpcPush]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const WOOKY_WS_PATH = "/ws";
export const WOOKY_DEFAULT_PORT = 4317;
/** How long the server waits for the folder dialog before killing its child. */
export const PICK_FOLDER_TIMEOUT_MS = 10 * 60 * 1000;
