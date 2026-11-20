import { resolve } from "node:path";
import type { ProviderEvent, TurnFailure } from "@wooky/contracts";
import { z } from "zod";
import { resolveCommand } from "../../process/resolve-command.ts";
import { prefixSessionPrompt } from "../agent-env.ts";
import { asDoneFailure, classifyGenericText } from "../failure.ts";
import type { TurnInput } from "../types.ts";
import { AcpClient, AcpClosedError, AcpMethodNotFound, AcpRpcError, acpDebug } from "./client.ts";
import { parsePermission, permissionResult, shouldAsk } from "./permission.ts";
import {
  ACP_PROTOCOL_VERSION,
  AUTH_REQUIRED_CODE,
  type ConfigOption,
  InitializeResult,
  METHOD_NOT_FOUND_CODE,
  PromptResult,
  LoadSessionResult,
  SessionResult,
  SessionUpdateParams,
  initializeParams,
  type RpcIdValue,
} from "./protocol.ts";
import { AcpTranslator } from "./translate.ts";

const KILL_GRACE_MS = 3_000;

export interface AcpTurnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Model id to select after the session exists. Absent means the agent default. */
  modelId?: string;
  missingCommand: string;
  killGraceMs?: number;
  maxLineBytes?: number;
  onDebug?: (message: string) => void;
  /**
   * When set, a completed turn that ran a tool without calling
   * session/request_permission gets one notice. OpenCode does not set this:
   * its permission env makes it ask.
   */
  noticeWhenSilent?: boolean;
}

export const SILENT_AGENT_NOTICE =
  "This agent does not ask before acting; runtime mode cannot be enforced";

class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
  }

  next(): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolveNext) => {
      this.waiters.push(resolveNext);
    });
  }
}

export async function* runAcpTurn(
  spec: AcpTurnSpec,
  input: TurnInput,
): AsyncGenerator<ProviderEvent> {
  if (input.signal.aborted) {
    yield interrupted();
    return;
  }

  const debug = spec.onDebug ?? acpDebug;
  let sawPermission = false;
  let sawTool = false;
  const resolved = resolveCommand(spec.command, spec.env);
  if (!resolved) {
    yield failed(spec.missingCommand);
    return;
  }

  const cwd = resolve(input.cwd);
  const translator = new AcpTranslator(input.turnId, debug);
  const queue = new EventQueue<ProviderEvent>();
  let acceptUpdates = false;
  let client: AcpClient | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionId: string | null = null;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    if (sessionId && client) client.notify("session/cancel", { sessionId });
    killTimer = setTimeout(() => client?.terminate(), spec.killGraceMs ?? KILL_GRACE_MS);
  };

  try {
    client = new AcpClient({
      command: resolved.command,
      args: [...resolved.prefixArgs, ...spec.args],
      cwd,
      env: spec.env,
      maxLineBytes: spec.maxLineBytes,
      killGraceMs: spec.killGraceMs ?? KILL_GRACE_MS,
      onDebug: debug,
      onNotification: (method, params) => {
        if (method !== "session/update") {
          debug(`acp: ignored notification ${method.slice(0, 200)}`);
          return;
        }
        if (!acceptUpdates) return;
        const parsed = SessionUpdateParams.safeParse(params);
        if (!parsed.success) {
          debug("acp: ignored invalid session update");
          return;
        }
        for (const event of translator.push(parsed.data.update)) {
          if (event.type === "item" && event.item.kind === "tool") sawTool = true;
          queue.push(event);
        }
      },
      onRequest: (method, params, id) => {
        if (method !== "session/request_permission")
          return Promise.reject(new AcpMethodNotFound(method));
        sawPermission = true;
        return answerPermission(params, id, input, () => aborted || input.signal.aborted);
      },
    });
    input.signal.addEventListener("abort", onAbort, { once: true });

    const init = await client.request("initialize", initializeParams(), InitializeResult);
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      yield failed(
        `This agent speaks ACP protocol ${init.protocolVersion}. Wooky speaks protocol ${ACP_PROTOCOL_VERSION}.`,
      );
      return;
    }

    const canLoad = init.agentCapabilities?.loadSession === true;
    let resuming = false;
    let configOptions: ConfigOption[] = [];
    let resumeNotice: string | null = null;
    if (canLoad && input.resumeSessionId) {
      try {
        const loaded = await client.request(
          "session/load",
          { sessionId: input.resumeSessionId, cwd, mcpServers: [] },
          LoadSessionResult,
        );
        sessionId = loaded.sessionId ?? input.resumeSessionId;
        configOptions = loaded.configOptions ?? [];
        resuming = true;
      } catch (error) {
        if (error instanceof AcpClosedError || input.signal.aborted) throw error;
        resumeNotice = "Could not resume the previous session, so this turn starts a new one.";
      }
    }
    if (!resuming) {
      const created = await client.request("session/new", { cwd, mcpServers: [] }, SessionResult);
      sessionId = created.sessionId;
      configOptions = created.configOptions ?? [];
    }
    if (!sessionId) {
      yield failed("The agent did not return a session.");
      return;
    }
    if (canLoad) yield { type: "session", sessionId };
    if (resumeNotice) {
      yield {
        type: "item",
        item: { kind: "notice", id: fitNotice(input.turnId), text: resumeNotice },
      };
    }

    const modelNotice = await selectModel(client, sessionId, spec.modelId, configOptions);
    if (modelNotice) {
      yield {
        type: "item",
        item: { kind: "notice", id: fitNotice(input.turnId, "model"), text: modelNotice },
      };
    }

    acceptUpdates = true;
    const outcome: { result: PromptResult | null; error: unknown } = { result: null, error: null };
    const promptSession = sessionId;
    void client
      .request(
        "session/prompt",
        {
          sessionId: promptSession,
          prompt: [{ type: "text", text: buildPrompt(input, resuming) }],
        },
        PromptResult,
      )
      .then(
        (result) => {
          outcome.result = result;
          queue.close();
        },
        (error: unknown) => {
          outcome.error = error;
          queue.close();
        },
      );

    for (;;) {
      const event = await queue.next();
      if (event === undefined) break;
      yield event;
    }

    if (input.signal.aborted || aborted) {
      yield interrupted();
      return;
    }
    if (outcome.error) {
      yield failedFromUnknown(outcome.error);
      return;
    }
    const terminal = doneFromStop(outcome.result?.stopReason ?? "end_turn");
    if (silentAgentNotice(spec, input, sawPermission, sawTool, terminal)) {
      yield {
        type: "item",
        item: {
          kind: "notice",
          id: fitNotice(input.turnId, "silent"),
          text: SILENT_AGENT_NOTICE,
        },
      };
    }
    yield terminal;
  } catch (error) {
    if (input.signal.aborted || aborted) yield interrupted();
    else yield failedFromUnknown(error);
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    await client?.close();
  }
}

function buildPrompt(input: TurnInput, resuming: boolean): string {
  const prefixed = prefixSessionPrompt(input.prompt, {
    resumeSessionId: resuming ? input.resumeSessionId : null,
    role: input.role,
  });
  if (!input.handoffContext || resuming) return prefixed;
  return `Earlier conversation in this thread, from another agent:\n\n${input.handoffContext}\n\n---\n\n${prefixed}`;
}

async function selectModel(
  client: AcpClient,
  sessionId: string,
  modelId: string | undefined,
  configOptions: ConfigOption[],
): Promise<string | null> {
  if (!modelId) return null;
  const option = configOptions.find((candidate) => candidate.id === "model");
  if (option) {
    if (option.currentValue === modelId) return null;
    await client.request(
      "session/set_config_option",
      { sessionId, configId: "model", value: modelId },
      z.unknown(),
    );
    return null;
  }
  try {
    await client.request("session/set_model", { sessionId, modelId }, z.unknown());
    return null;
  } catch (error) {
    if (error instanceof AcpRpcError && error.code === METHOD_NOT_FOUND_CODE) {
      return "This agent has no model setting, so it will use its own default.";
    }
    throw error;
  }
}

function answerPermission(
  params: unknown,
  rpcId: RpcIdValue,
  input: TurnInput,
  cancelled: () => boolean,
): Promise<unknown> {
  const parsed = parsePermission(params, rpcId);
  if (!parsed) return Promise.reject(new Error("Invalid permission request."));
  if (cancelled()) return Promise.resolve(permissionResult("cancel", parsed.options));
  if (
    !shouldAsk({
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      tool: parsed.request.tool,
    })
  ) {
    return Promise.resolve(permissionResult("allow", parsed.options));
  }
  return input.requestApproval(parsed.request).then((decision) => {
    if (cancelled()) return permissionResult("cancel", parsed.options);
    return permissionResult(decision, parsed.options);
  });
}

function interrupted(): Extract<ProviderEvent, { type: "done" }> {
  return { type: "done", status: "interrupted", error: null };
}

function failed(message: string, failure?: TurnFailure): Extract<ProviderEvent, { type: "done" }> {
  const text = message.length > 2_000 ? message.slice(0, 2_000) : message;
  return {
    type: "done",
    status: "failed",
    error: text,
    ...(failure ? { failure } : {}),
  };
}

function failedFromUnknown(error: unknown): ProviderEvent {
  if (error instanceof AcpRpcError && error.code === AUTH_REQUIRED_CODE) {
    const message = error.message || "Authentication required.";
    return failed(message, { kind: "auth", message: message.slice(0, 2_000) });
  }
  const text =
    error instanceof AcpClosedError
      ? error.stderr.trim() || error.message
      : error instanceof Error
        ? error.message
        : "The agent failed.";
  const failure = asDoneFailure(classifyGenericText(text));
  return failed(text, failure);
}

function silentAgentNotice(
  spec: AcpTurnSpec,
  input: TurnInput,
  sawPermission: boolean,
  sawTool: boolean,
  terminal: Extract<ProviderEvent, { type: "done" }>,
): boolean {
  return (
    spec.noticeWhenSilent === true &&
    sawTool &&
    !sawPermission &&
    input.runtimeMode !== "full" &&
    terminal.status === "completed"
  );
}

function doneFromStop(stopReason: string): Extract<ProviderEvent, { type: "done" }> {
  if (stopReason === "cancelled") return interrupted();
  if (stopReason === "refusal") return failed("The agent refused this turn.");
  return { type: "done", status: "completed", error: null };
}

function fitNotice(turnId: string, suffix = "resume"): string {
  const raw = `${turnId}:${suffix}`;
  return raw.length <= 128 ? raw : raw.slice(0, 128);
}

export function agentLabel(init: z.infer<typeof InitializeResult>): string | null {
  const info = init.agentInfo;
  if (!info) return null;
  const name = info.title || info.name;
  if (!name && !info.version) return null;
  if (name && info.version) return `${name} ${info.version}`;
  return name || info.version || null;
}
