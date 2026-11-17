import { z } from "zod";
import { AppearanceTheme, AppearanceThemeSummary, DeviceSettings } from "./appearance.ts";
import { Command } from "./commands.ts";
import { AgeEvent } from "./events.ts";
import { FileDiff, Id, Project, ProviderStatus, Thread, Turn } from "./model.ts";
import { TerminalPush, TerminalSessionId } from "./terminal.ts";
import { ProviderLimits } from "./usage.ts";

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
});
export type ReadModel = z.infer<typeof ReadModel>;

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
  /** Start a local shell in cwd (project/worktree root). One session per call. */
  "terminal.open": {
    params: z.object({
      cwd: z.string().min(1).optional(),
      cols: z.number().int().positive().optional(),
      rows: z.number().int().positive().optional(),
    }),
    result: z.object({ sessionId: TerminalSessionId, shell: z.string() }),
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

export const RpcPush = z.union([RpcEventPush, TerminalPush]);
export type RpcPush = z.infer<typeof RpcPush>;

export const ServerMessage = z.union([RpcResponse, RpcPush]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const AGE_WS_PATH = "/ws";
export const AGE_DEFAULT_PORT = 4317;
