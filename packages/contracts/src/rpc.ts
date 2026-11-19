import { z } from "zod";
import {
  AppearanceTheme,
  AppearanceThemeSummary,
  DeviceSettings,
  ThemeImportFormat,
} from "./appearance.ts";
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
  Project,
  ProviderKind,
  ProviderStatus,
  ReviewNote,
  Thread,
  ThreadGroup,
  Turn,
} from "./model.ts";
import { TerminalPush, TerminalSessionId } from "./terminal.ts";
import { ProviderLimits, UsageHistoryParams, UsageHistoryResult } from "./usage.ts";

/**
 * Wire protocol over a single WebSocket at /ws.
 * client -> server: RpcRequest
 * server -> client: RpcResponse | RpcPush
 * The server is authoritative. Clients send commands and render pushed events.
 */

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
});
export type ReadModel = z.infer<typeof ReadModel>;

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
  "settings.get": { params: z.object({}), result: DeviceSettings },
  "settings.put": {
    params: z.object({ settings: DeviceSettings.partial() }),
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
   * Import AGE theme JSON, a t3code theme JSON (version, name, appearance,
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
    }),
    result: z.object({
      sessionId: TerminalSessionId,
      shell: z.string(),
      /** CRLF on Windows shells, LF elsewhere. Absent on older servers; clients use LF. */
      lineEnding: z.enum(["\n", "\r\n"]).optional(),
    }),
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
   * Every thread the server knows, for the fleet board and `age agents list`.
   * The same rows are `fleetRows` in `@age/domain`; the RPC exists for the CLI.
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
  /** `age agents spawn`. Same fields as `thread.spawn`, without a command id. */
  "agents.spawn": {
    params: ThreadSpawnParams,
    result: z.object({ threadId: Id }),
  },
  /** `age agents list`. Overview rows whose parent is this coordinator. */
  "agents.list": {
    params: z.object({ parentThreadId: Id }),
    result: z.array(FleetRow),
  },
  /** `age agents wait`. Blocks until each thread is done or failed, or the timeout fires. */
  "agents.wait": {
    params: z.object({
      threadIds: z.array(Id),
      timeoutMs: z.number().int().nonnegative().max(FLEET_LIMITS.maxAgentsWaitMs),
    }),
    result: z.object({
      finished: z.array(Id),
      pending: z.array(Id),
    }),
  },
  /** `age agents result`. Summary of the worker's latest report. */
  "agents.result": {
    params: z.object({ threadId: Id }),
    result: AgentResult,
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
  code: z.enum(["bad_request", "not_found", "conflict", "unavailable", "internal"]),
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

export const RpcPush = z.union([RpcEventPush, TerminalPush, ThemesPush]);
export type RpcPush = z.infer<typeof RpcPush>;

export const ServerMessage = z.union([RpcResponse, RpcPush]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const AGE_WS_PATH = "/ws";
export const AGE_DEFAULT_PORT = 4317;
/** How long the server waits for the folder dialog before killing its child. */
export const PICK_FOLDER_TIMEOUT_MS = 10 * 60 * 1000;
