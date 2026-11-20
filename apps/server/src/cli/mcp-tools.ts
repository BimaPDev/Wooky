import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AgeEvent,
  ProviderKind,
  RpcMethods,
  RuntimeMode,
  WOOKY_WS_PATH,
  type AgeEventOf,
  type ProviderKind as ProviderKindName,
  type ProviderStatus,
  type ReadModel,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type Turn,
} from "@wooky/contracts";
import { activeTurn, fleetRows } from "@wooky/domain";
import { WebSocket, type RawData } from "ws";
import { discoverServerUrl, SERVER_DOWN } from "../presence.ts";

const TEXT_LIMIT = 20_000;
const TRUNCATION_NOTE = "Truncated to 20000 characters.";
const DOWN = "Wooky is not running. Start it with `wooky` or open the app.";
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;

const FLEET_STATUSES = ["working", "waiting", "idle", "done", "failed"] as const;

export interface McpFlags {
  projects: ReadonlySet<string> | null;
  readOnly: boolean;
  allowApprovals: boolean;
  allowFull: boolean;
}

const FULL_RUNTIME_ERROR = "Start `wooky mcp --allow-full` to allow full runtime.";
const RUNTIME_RANK: Record<RuntimeMode, number> = { approve: 0, "auto-edits": 1, full: 2 };

/** No requested mode uses the ceiling: approve, or full when the process was started with --allow-full. */
export function resolveRuntimeMode(requested: string | undefined, allowFull: boolean): RuntimeMode {
  const ceiling: RuntimeMode = allowFull ? "full" : "approve";
  if (requested === undefined) return ceiling;
  const parsed = RuntimeMode.safeParse(requested);
  if (!parsed.success) throw new ToolError("runtimeMode must be approve, auto-edits, or full.");
  if (RUNTIME_RANK[parsed.data] > RUNTIME_RANK[ceiling]) throw new ToolError(FULL_RUNTIME_ERROR);
  return parsed.data;
}

export interface AgentChoice {
  provider: ProviderKindName;
  model: string;
}

/**
 * Same default as the composer's draft: the requested provider when it is usable, otherwise the
 * first available one. The model is the one asked for on that provider, else its defaultModel,
 * else its first model. Demo is used only when that walk selects it.
 */
export function resolveDefaultTarget(
  providers: readonly ProviderStatus[],
  settings: {
    disabledProviders?: readonly ProviderKindName[];
    providers?: Partial<Record<ProviderKindName, { defaultModel?: string } | undefined>>;
  } | null,
  requested?: { provider?: ProviderKindName; model?: string },
): AgentChoice | null {
  const disabled = new Set(settings?.disabledProviders ?? []);
  const usable = (kind: ProviderKindName | undefined) =>
    kind === undefined
      ? undefined
      : providers.find((entry) => entry.kind === kind && providerAvailable(entry, disabled));
  const chosen =
    usable(requested?.provider) ?? providers.find((entry) => providerAvailable(entry, disabled));
  if (!chosen) return null;
  const model =
    requested?.model && requested.provider === chosen.kind
      ? requested.model
      : defaultModelId(chosen, settings);
  if (!model) return null;
  return { provider: chosen.kind, model };
}

function providerAvailable(
  provider: ProviderStatus,
  disabled: ReadonlySet<ProviderKindName>,
): boolean {
  return (
    !disabled.has(provider.kind) &&
    provider.installed &&
    provider.authenticated !== false &&
    !provider.problem
  );
}

function defaultModelId(
  status: ProviderStatus,
  settings: {
    providers?: Partial<Record<ProviderKindName, { defaultModel?: string } | undefined>>;
  } | null,
): string {
  const configured = settings?.providers?.[status.kind]?.defaultModel;
  const ids = status.models.map((model) => model.id);
  if (configured && ids.includes(configured)) return configured;
  return ids[0] ?? "";
}

/** The wait loop calls this after each snapshot. A missing thread was removed while it waited. */
export function assertWaitingThread(model: ReadModel, threadId: string): void {
  if (!model.threads[threadId]) throw new ToolError("Thread was removed.");
}

export interface ToolContext {
  env: NodeJS.ProcessEnv;
  flags: McpFlags;
}

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  gated?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

let cachedVersion: string | undefined;

export function serverVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version?: unknown;
    };
    cachedVersion = typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

const TOOLS: Tool[] = [
  {
    name: "wooky_overview",
    description:
      "Server version, projects (id, name, path), and how many threads are in each status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    run: (_args, ctx) => overview(ctx),
  },
  {
    name: "wooky_list_threads",
    description:
      "Threads, newest activity first: id, title, provider, model, status, last activity, and worktree branch. At most 50.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Only threads in this project." },
        status: { type: "string", enum: [...FLEET_STATUSES] },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 50." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: (args, ctx) => listThreads(args, ctx),
  },
  {
    name: "wooky_create_task",
    description:
      "Create a thread and start its first turn. Returns the thread id. runtimeMode defaults to approve, the composer's default, unless this process was started with --allow-full. In approve mode the Wooky UI shows each approval; wooky_wait returns blocked, and wooky_approve needs --allow-approvals. isolate defaults to true (its own git worktree). provider and model default to the first available provider and its default model.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        prompt: { type: "string" },
        provider: {
          type: "string",
          enum: [...ProviderKind.options],
          description: "Defaults to the first available provider.",
        },
        model: { type: "string", description: "Defaults to that provider's default model." },
        runtimeMode: {
          type: "string",
          enum: ["approve", "auto-edits", "full"],
          description: "Cannot exceed approve unless started with --allow-full.",
        },
        isolate: { type: "boolean", description: "Own worktree. Default true." },
        title: { type: "string" },
      },
      required: ["projectId", "prompt"],
      additionalProperties: false,
    },
    readOnly: false,
    run: (args, ctx) => createTask(args, ctx),
  },
  {
    name: "wooky_send",
    description:
      "Send a follow-up on a thread. Starts a turn, or queues the prompt when a turn is already running.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["threadId", "prompt"],
      additionalProperties: false,
    },
    readOnly: false,
    run: (args, ctx) => sendPrompt(args, ctx),
  },
  {
    name: "wooky_wait",
    description:
      "Wait until the thread's current turn finishes. If that turn is blocked on an approval or a question, returns immediately instead of waiting out the timeout. timeoutMs defaults to 120000 and is at most 600000.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        timeoutMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    readOnly: true,
    run: (args, ctx) => waitForTurn(args, ctx),
  },
  {
    name: "wooky_read",
    description:
      "Final assistant text of each turn, plus a diff stat for the thread. Omits tool traces. Truncates at about 20000 characters.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        sinceTurn: { type: "string", description: "Return only turns after this id." },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    readOnly: true,
    run: (args, ctx) => readThread(args, ctx),
  },
  {
    name: "wooky_interrupt",
    description: "Interrupt the running turn on a thread.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
    readOnly: false,
    run: (args, ctx) => interrupt(args, ctx),
  },
  {
    name: "wooky_approve",
    description:
      "Approve or deny one pending approval. Gated: only exposed when this process is started with --allow-approvals, which is off by default.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        approvalId: { type: "string" },
        decision: { type: "string", enum: ["approve", "deny"] },
      },
      required: ["threadId", "approvalId", "decision"],
      additionalProperties: false,
    },
    readOnly: false,
    gated: true,
    run: (args, ctx) => approve(args, ctx),
  },
];

function exposed(tool: Tool, flags: McpFlags): boolean {
  if (flags.readOnly && !tool.readOnly) return false;
  if (tool.gated && !flags.allowApprovals) return false;
  return true;
}

export function listTools(flags: McpFlags): {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}[] {
  return TOOLS.filter((tool) => exposed(tool, flags)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolCallResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return toolError(`Unknown tool ${name}.`);
  if (ctx.flags.readOnly && !tool.readOnly) {
    return toolError(`${name} is not available in read-only mode.`);
  }
  if (tool.gated && !ctx.flags.allowApprovals) {
    return toolError("wooky_approve is off. Start `wooky mcp` with --allow-approvals.");
  }
  try {
    return { content: [{ type: "text", text: formatToolResult(await tool.run(args, ctx)) }] };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "The tool failed.");
  }
}

function toolError(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function formatToolResult(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= TEXT_LIMIT) return text;
  let budget = TEXT_LIMIT;
  let wrapped = wrap(text.slice(0, budget));
  while (wrapped.length > TEXT_LIMIT && budget > 200) {
    budget = Math.floor(budget * 0.8);
    wrapped = wrap(text.slice(0, budget));
  }
  return wrapped;
}

function wrap(text: string): string {
  return JSON.stringify({ note: TRUNCATION_NOTE, text }, null, 2);
}

async function overview(ctx: ToolContext): Promise<unknown> {
  return withServer(ctx.env, async (session) => {
    const model = await session.call("snapshot", {});
    const counts = { working: 0, waiting: 0, idle: 0, done: 0, failed: 0 };
    for (const row of fleetRows(model)) {
      if (!projectAllowed(ctx.flags, row.projectId)) continue;
      counts[row.status] += 1;
    }
    const projects = Object.values(model.projects)
      .filter((project) => projectAllowed(ctx.flags, project.id))
      .map((project) => ({ id: project.id, name: project.name, path: project.root }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { version: serverVersion(), projects, threads: counts };
  });
}

async function listThreads(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["projectId", "status", "limit"]);
  const projectId = optionalString(args, "projectId");
  const status = optionalStatus(args);
  const limit = integerArg(args, "limit", 50, 1, 50);
  if (projectId) assertProject(ctx.flags, projectId);
  return withServer(ctx.env, async (session) => {
    const model = await session.call("snapshot", {});
    if (projectId && !model.projects[projectId]) {
      throw new ToolError(`No project with id ${projectId}.`);
    }
    const threads = fleetRows(model)
      .filter((row) => projectAllowed(ctx.flags, row.projectId))
      .filter((row) => !projectId || row.projectId === projectId)
      .filter((row) => !status || row.status === status)
      .slice(0, limit)
      .map((row) => ({
        id: row.threadId,
        title: row.title,
        provider: row.provider,
        model: row.model,
        status: row.status,
        lastActivityAt: row.lastActivityAt,
        branch: model.threads[row.threadId]?.worktree?.branch ?? null,
      }));
    return { threads };
  });
}

async function createTask(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["projectId", "prompt", "provider", "model", "runtimeMode", "isolate", "title"]);
  const projectId = requireString(args, "projectId");
  const prompt = requireString(args, "prompt");
  const requestedProvider = optionalProvider(args);
  const requestedModel = optionalString(args, "model");
  const runtimeMode = resolveRuntimeMode(optionalString(args, "runtimeMode"), ctx.flags.allowFull);
  const isolate = booleanArg(args, "isolate", true);
  const title = optionalString(args, "title");
  assertProject(ctx.flags, projectId);
  return withServer(ctx.env, async (session) => {
    const before = await session.call("snapshot", {});
    if (!before.projects[projectId]) throw new ToolError(`No project with id ${projectId}.`);
    const [listed, settings] = await Promise.all([
      session.call("providers.list", {}),
      session.call("settings.get", {}),
    ]);
    const target = resolveDefaultTarget(listed, settings, {
      ...(requestedProvider ? { provider: requestedProvider } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
    });
    if (!target) throw new ToolError("No agent is available.");
    const commandId = newCommandId();
    await session.call("dispatch", {
      commandId,
      type: "thread.create",
      projectId,
      provider: target.provider,
      model: target.model,
      runtimeMode,
      isolate,
      ...(title ? { title } : {}),
    });
    await session.call("subscribe", { fromSeq: before.seq });
    const created = session.events.find(
      (event): event is AgeEventOf<"thread.created"> =>
        event.type === "thread.created" && event.commandId === commandId,
    );
    if (!created) throw new ToolError("The new thread did not appear.");
    const threadId = created.thread.id;
    try {
      await session.call("dispatch", {
        commandId: newCommandId(),
        type: "turn.start",
        threadId,
        prompt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The turn did not start.";
      throw new ToolError(`Thread ${threadId} was created, but the turn did not start: ${message}`);
    }
    return { threadId };
  });
}

async function sendPrompt(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["threadId", "prompt"]);
  const threadId = requireString(args, "threadId");
  const prompt = requireString(args, "prompt");
  return withServer(ctx.env, async (session) => {
    const before = await session.call("snapshot", {});
    requireThread(before, threadId, ctx.flags);
    const commandId = newCommandId();
    await session.call("dispatch", {
      commandId,
      type: "turn.start",
      threadId,
      prompt,
      whenBusy: "queue",
    });
    await session.call("subscribe", { fromSeq: before.seq });
    const queued = session.events.some(
      (event) => event.type === "queue.added" && event.commandId === commandId,
    );
    return { threadId, queued };
  });
}

type WaitBody =
  | { state: "finished"; turnId: string | null; turnStatus: Turn["status"] | null }
  | {
      state: "blocked";
      waitingOn: "approval";
      turnId: string;
      approvalId: string;
      title: string;
    }
  | {
      state: "blocked";
      waitingOn: "question";
      turnId: string;
      questionId: string;
      questions: string[];
    };

/**
 * `agents.wait` settles only when fleet status is done or failed. A solo thread
 * goes idle when its turn ends, and a turn blocked on the user stays waiting
 * until that timeout. Watch this turn's own events instead.
 */
async function waitForTurn(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["threadId", "timeoutMs"]);
  const threadId = requireString(args, "threadId");
  const timeoutMs = integerArg(args, "timeoutMs", DEFAULT_WAIT_MS, 0, MAX_WAIT_MS);
  return withServer(ctx.env, async (session) => {
    let model = await session.call("snapshot", {});
    requireThread(model, threadId, ctx.flags);
    const initial = judge(model, threadId);
    if (initial.kind === "settled") return { threadId, ...initial.body };
    if (timeoutMs === 0) return { threadId, state: "timeout", turnId: initial.turnId, timeoutMs };
    await session.call("subscribe", { fromSeq: model.seq });
    const deadline = Date.now() + timeoutMs;
    let afterSeq = model.seq;
    const turnId = initial.turnId;
    while (true) {
      const remaining = deadline - Date.now();
      const event =
        remaining > 0
          ? await session.nextEvent(
              (candidate) =>
                candidate.seq > afterSeq &&
                eventThreadId(candidate) === threadId &&
                (candidate.type === "thread.removed" ||
                  (eventTurnId(candidate) === turnId &&
                    (candidate.type === "turn.finished" ||
                      candidate.type === "approval.requested" ||
                      candidate.type === "question.requested"))),
              remaining,
            )
          : null;
      model = await session.call("snapshot", {});
      assertWaitingThread(model, threadId);
      const next = judgeTurn(model, threadId, turnId);
      if (next.kind === "settled") return { threadId, ...next.body };
      if (!event) return { threadId, state: "timeout", turnId, timeoutMs };
      afterSeq = event.seq;
    }
  });
}

async function readThread(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["threadId", "sinceTurn"]);
  const threadId = requireString(args, "threadId");
  const sinceTurn = optionalString(args, "sinceTurn");
  return withServer(ctx.env, async (session) => {
    const model = await session.call("snapshot", {});
    const thread = requireThread(model, threadId, ctx.flags);
    const turns = model.turns[threadId] ?? [];
    let selected = turns;
    if (sinceTurn) {
      const index = turns.findIndex((turn) => turn.id === sinceTurn);
      if (index === -1) throw new ToolError(`No turn with id ${sinceTurn}.`);
      selected = turns.slice(index + 1);
    }
    let diffStat: { files: number; additions: number; deletions: number } | null = null;
    try {
      const files = await session.call("git.diff", { threadId });
      diffStat = {
        files: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      };
    } catch (error) {
      if (serverDown(error)) throw error;
    }
    return {
      threadId,
      title: thread.title,
      turns: selected.map((turn) => ({
        turnId: turn.id,
        status: turn.status,
        text: assistantText(turn),
      })),
      diffStat,
    };
  });
}

async function interrupt(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["threadId"]);
  const threadId = requireString(args, "threadId");
  return withServer(ctx.env, async (session) => {
    const model = await session.call("snapshot", {});
    requireThread(model, threadId, ctx.flags);
    await session.call("dispatch", {
      commandId: newCommandId(),
      type: "turn.interrupt",
      threadId,
    });
    return { threadId };
  });
}

async function approve(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  knownKeys(args, ["threadId", "approvalId", "decision"]);
  const threadId = requireString(args, "threadId");
  const approvalId = requireString(args, "approvalId");
  const decision = args.decision;
  if (decision !== "approve" && decision !== "deny") {
    throw new ToolError('decision must be "approve" or "deny".');
  }
  return withServer(ctx.env, async (session) => {
    const model = await session.call("snapshot", {});
    requireThread(model, threadId, ctx.flags);
    await session.call("dispatch", {
      commandId: newCommandId(),
      type: "approval.respond",
      threadId,
      requestId: approvalId,
      decision: decision === "approve" ? "allow" : "deny",
    });
    return { threadId, approvalId, decision };
  });
}

type Judgement = { kind: "settled"; body: WaitBody } | { kind: "running"; turnId: string };

function judge(model: ReadModel, threadId: string): Judgement {
  const running = activeTurn(model, threadId);
  if (!running) {
    const last = model.turns[threadId]?.at(-1);
    return {
      kind: "settled",
      body: { state: "finished", turnId: last?.id ?? null, turnStatus: last?.status ?? null },
    };
  }
  return judgeTurn(model, threadId, running.id);
}

function judgeTurn(model: ReadModel, threadId: string, turnId: string): Judgement {
  const turn = model.turns[threadId]?.find((candidate) => candidate.id === turnId);
  if (!turn || turn.status !== "running") {
    return {
      kind: "settled",
      body: { state: "finished", turnId, turnStatus: turn?.status ?? null },
    };
  }
  for (const item of turn.items) {
    if (item.kind === "approval" && item.decision === null) {
      return {
        kind: "settled",
        body: {
          state: "blocked",
          waitingOn: "approval",
          turnId,
          approvalId: item.requestId,
          title: item.title,
        },
      };
    }
  }
  for (const item of turn.items) {
    if (item.kind === "question" && item.answers === null && item.dismissed !== true) {
      return {
        kind: "settled",
        body: {
          state: "blocked",
          waitingOn: "question",
          turnId,
          questionId: item.requestId,
          questions: item.questions.map((question) => question.question),
        },
      };
    }
  }
  return { kind: "running", turnId };
}

function assistantText(turn: Turn): string {
  let text = "";
  for (const item of turn.items) {
    if (item.kind === "message" && item.role === "assistant") text = item.text;
  }
  return text;
}

function requireThread(model: ReadModel, threadId: string, flags: McpFlags) {
  const thread = model.threads[threadId];
  if (!thread) throw new ToolError(`No thread with id ${threadId}.`);
  assertProject(flags, thread.projectId);
  return thread;
}

function assertProject(flags: McpFlags, projectId: string): void {
  if (!projectAllowed(flags, projectId)) {
    throw new ToolError(`Project ${projectId} is outside the projects this server may use.`);
  }
}

function projectAllowed(flags: McpFlags, projectId: string): boolean {
  return flags.projects === null || flags.projects.has(projectId);
}

function knownKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ToolError(`Unknown argument ${key}.`);
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`${key} is required.`);
  return value.trim();
}

function optionalProvider(input: Record<string, unknown>): ProviderKindName | undefined {
  const value = optionalString(input, "provider");
  if (value === undefined) return undefined;
  const parsed = ProviderKind.safeParse(value);
  if (!parsed.success) throw new ToolError(`provider must be ${ProviderKind.options.join(", ")}.`);
  return parsed.data;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  if (input[key] === undefined) return undefined;
  const value = input[key];
  if (typeof value !== "string") throw new ToolError(`${key} must be a string.`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function booleanArg(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (input[key] === undefined) return fallback;
  const value = input[key];
  if (typeof value !== "boolean") throw new ToolError(`${key} must be a boolean.`);
  return value;
}

function integerArg(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (input[key] === undefined) return fallback;
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${key} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function optionalStatus(
  input: Record<string, unknown>,
): (typeof FLEET_STATUSES)[number] | undefined {
  if (input.status === undefined) return undefined;
  const value = input.status;
  if (typeof value !== "string" || !FLEET_STATUSES.some((status) => status === value)) {
    throw new ToolError(`status must be ${FLEET_STATUSES.join(", ")}.`);
  }
  return value as (typeof FLEET_STATUSES)[number];
}

function newCommandId(): string {
  return `mcp-${randomUUID()}`;
}

function eventThreadId(event: AgeEvent): string | null {
  return "threadId" in event ? event.threadId : null;
}

function eventTurnId(event: AgeEvent): string | null {
  return "turnId" in event ? event.turnId : null;
}

function serverDown(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === SERVER_DOWN ||
    error.message === DOWN ||
    error.message === "The connection to Wooky closed." ||
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("EHOSTUNREACH")
  );
}

async function withServer<T>(
  env: NodeJS.ProcessEnv,
  run: (session: RpcSession) => Promise<T>,
): Promise<T> {
  let session: RpcSession | undefined;
  try {
    session = await RpcSession.connect(discoverServerUrl(env));
    return await run(session);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (serverDown(error)) throw new ToolError(DOWN);
    throw new ToolError(error instanceof Error ? error.message : "Request failed.");
  } finally {
    session?.close();
  }
}

function webSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = WOOKY_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

let listenerBalance = 0;
let pendingBalance = 0;

export function rpcSessionLoad(): { listeners: number; pending: number } {
  return { listeners: listenerBalance, pending: pendingBalance };
}

function noteListenerAdded(): void {
  listenerBalance += 1;
}

function noteListenerRemoved(): void {
  listenerBalance -= 1;
}

class RpcSession {
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly listeners = new Set<(event: AgeEvent) => void>();
  private readonly aborts = new Set<(error: Error) => void>();
  readonly events: AgeEvent[] = [];
  private nextId = 1;
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.shutdown(new Error("The connection to Wooky closed.")));
    ws.on("error", () => this.shutdown(new Error("The connection to Wooky closed.")));
  }

  static connect(serverUrl: string): Promise<RpcSession> {
    const ws = new WebSocket(webSocketUrl(serverUrl));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error(DOWN)), CONNECT_TIMEOUT_MS);
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off("error", onError);
        run();
      };
      const fail = (error: Error) =>
        finish(() => {
          ws.terminate();
          reject(error);
        });
      const onError = (error: Error) => fail(error instanceof Error ? error : new Error(DOWN));
      ws.once("error", onError);
      ws.once("open", () => finish(() => resolve(new RpcSession(ws))));
    });
  }

  call<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<RpcResult<M>> {
    if (this.closed) return Promise.reject(new Error("The connection to Wooky closed."));
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dropPending(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      pendingBalance += 1;
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    return result.then((value) => {
      const parsed = RpcMethods[method].result.safeParse(value);
      if (!parsed.success) throw new Error(`Unexpected ${method} result.`);
      return parsed.data as RpcResult<M>;
    });
  }

  nextEvent(match: (event: AgeEvent) => boolean, timeoutMs: number): Promise<AgeEvent | null> {
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);
    if (timeoutMs <= 0 || this.closed) {
      return this.closed
        ? Promise.reject(new Error("The connection to Wooky closed."))
        : Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => settle(null, null), timeoutMs);
      const settle = (error: Error | null, event?: AgeEvent | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.listeners.delete(onEvent)) noteListenerRemoved();
        this.aborts.delete(abort);
        if (error) reject(error);
        else resolve(event ?? null);
      };
      const abort = (error: Error) => settle(error);
      const onEvent = (event: AgeEvent) => {
        if (match(event)) settle(null, event);
      };
      this.listeners.add(onEvent);
      noteListenerAdded();
      this.aborts.add(abort);
      const raced = this.events.find(match);
      if (raced) settle(null, raced);
    });
  }

  private dropPending(id: number): void {
    if (!this.pending.delete(id)) return;
    pendingBalance -= 1;
  }

  close(): void {
    this.shutdown(new Error("The connection to Wooky closed."));
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
      this.ws.terminate();
    }
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingBalance -= this.pending.size;
    this.pending.clear();
    for (const abort of [...this.aborts]) abort(error);
    this.aborts.clear();
    listenerBalance -= this.listeners.size;
    this.listeners.clear();
  }

  private onMessage(data: RawData): void {
    let raw: unknown;
    try {
      raw = JSON.parse(textOf(data));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (message.push === "event") {
      this.bufferEvent(message.event);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.dropPending(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const body = message.error as { message?: unknown } | undefined;
      const text = typeof body?.message === "string" ? body.message : "Request failed.";
      pending.reject(new Error(text));
    }
  }

  private bufferEvent(value: unknown): void {
    if (value && typeof value === "object" && "type" in value && value.type === "turn.itemDelta") {
      return;
    }
    const parsed = AgeEvent.safeParse(value);
    if (!parsed.success) return;
    this.events.push(parsed.data);
    for (const listener of [...this.listeners]) listener(parsed.data);
  }
}

function textOf(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
