import type { ProviderEvent, TimelineItem, TurnFailure, Usage } from "@wooky/contracts";
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { asDoneFailure } from "../failure.ts";
import { classifyClaudeFailure } from "./classify.ts";
import { clip, truncateBytes } from "./text.ts";
import { describeTool } from "./tools.ts";

const OUTPUT_MAX_BYTES = 4 * 1024;

export type FinishReason =
  { kind: "aborted" } | { kind: "error"; error: unknown } | { kind: "ended"; stderr?: string };

export interface Translator {
  push(message: SDKMessage): ProviderEvent[];
  /** Close the turn when the stream ended, was aborted or threw. No-op once `done` was emitted. */
  finish(reason: FinishReason): ProviderEvent[];
  noteRateLimit(info: SDKRateLimitInfo): void;
}

export interface TranslatorOptions {
  /** Prefixed to every item id so ids are unique within the turn. */
  turnId?: string;
  /** Used to show paths relative to the workspace. */
  cwd?: string;
  /** Set when a plan event was emitted this turn (ExitPlanMode interrupt should still complete). */
  planProposed?: { value: boolean };
}

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type TextKind = "message" | "reasoning";

interface StreamBlock {
  index: number;
  kind: TextKind;
  id: string;
  started: boolean;
  /** The final text arrived; later deltas for this block are dropped. */
  consumed: boolean;
}

interface MessageState {
  blocks: StreamBlock[];
  /** Final blocks seen so far, used to name items that were never streamed. */
  finals: number;
}

const NOT_SIGNED_IN =
  "Claude Code is not signed in. Open `claude` in a terminal, run /login, then try again.";

export function createTranslator(options: TranslatorOptions = {}): Translator {
  const turnId = options.turnId ?? "turn";
  const cwd = options.cwd ?? "";
  const messages = new Map<string, MessageState>();
  const tools = new Map<string, ToolItem>();
  let streamMessageId = "stream";
  let sessionId: string | null = null;
  let authFailed = false;
  let finished = false;
  let lastChainUuid: string | null = null;
  let lastRateLimit: SDKRateLimitInfo | null = null;
  const planProposed = options.planProposed;

  const stateFor = (messageId: string): MessageState => {
    let state = messages.get(messageId);
    if (!state) {
      state = { blocks: [], finals: 0 };
      messages.set(messageId, state);
    }
    return state;
  };

  const textItem = (kind: TextKind, id: string, text: string): TimelineItem =>
    kind === "message" ? { kind, id, role: "assistant", text } : { kind, id, text };

  function register(messageId: string, index: number, kind: TextKind, opened = false): StreamBlock {
    const state = stateFor(messageId);
    const known = state.blocks.find((block) => block.index === index);
    if (known && !(opened && known.consumed)) return known;
    const generation = state.blocks.filter((block) => block.index === index).length;
    const block: StreamBlock = {
      index,
      kind,
      id: `${turnId}:${messageId}:${index}${generation > 0 ? `.${generation}` : ""}`,
      started: false,
      consumed: false,
    };
    state.blocks.push(block);
    return block;
  }

  function stream(message: SDKPartialAssistantMessage, out: ProviderEvent[]) {
    if (message.parent_tool_use_id) return;
    const event = message.event;
    if (event.type === "message_start") {
      streamMessageId = event.message.id;
    } else if (event.type === "content_block_start") {
      const type = event.content_block.type;
      if (type === "text") register(streamMessageId, event.index, "message", true);
      else if (type === "thinking") register(streamMessageId, event.index, "reasoning", true);
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      const [kind, text] =
        delta.type === "text_delta"
          ? (["message", delta.text] as const)
          : delta.type === "thinking_delta"
            ? (["reasoning", delta.thinking] as const)
            : ([null, ""] as const);
      if (!kind || text === "") return;
      const block = register(streamMessageId, event.index, kind);
      if (block.consumed) return;
      if (!block.started) {
        block.started = true;
        out.push({ type: "item", item: textItem(kind, block.id, "") });
      }
      out.push({ type: "delta", itemId: block.id, text });
    }
  }

  function upsertFinalText(messageId: string, kind: TextKind, text: string, out: ProviderEvent[]) {
    const state = stateFor(messageId);
    const open = (block: StreamBlock) => !block.consumed && block.started && block.kind === kind;
    const streamed =
      state.blocks.find(open) ?? [...messages.values()].flatMap((other) => other.blocks).find(open);
    const ordinal = state.finals++;
    if (streamed) streamed.consumed = true;
    if (text === "") return;
    const id = streamed?.id ?? `${turnId}:${messageId}:f${ordinal}`;
    out.push({ type: "item", item: textItem(kind, id, text) });
  }

  function assistant(message: SDKAssistantMessage, out: ProviderEvent[]) {
    if (message.error === "authentication_failed") authFailed = true;
    const fromSubagent = message.parent_tool_use_id !== null;
    if (!fromSubagent) {
      lastChainUuid = message.uuid;
    }
    for (const block of message.message.content) {
      if (block.type === "text" && !fromSubagent) {
        upsertFinalText(message.message.id, "message", block.text, out);
      } else if (block.type === "thinking" && !fromSubagent) {
        upsertFinalText(message.message.id, "reasoning", block.thinking, out);
      } else if (block.type === "tool_use") {
        const id = `${turnId}:${block.id}`;
        if (tools.has(id)) continue;
        const input =
          typeof block.input === "object" && block.input !== null
            ? (block.input as Record<string, unknown>)
            : {};
        const described = describeTool(block.name, input, cwd);
        const item: ToolItem = {
          kind: "tool",
          id,
          tool: described.kind,
          title: described.title,
          name: block.name,
          status: "running",
          ...(described.files ? { files: described.files } : {}),
        };
        tools.set(id, item);
        out.push({ type: "item", item });
      }
    }
  }

  function toolResults(message: SDKUserMessage, out: ProviderEvent[]) {
    if (message.parent_tool_use_id === null && message.uuid) {
      lastChainUuid = message.uuid;
    }
    const content = message.message.content;
    if (typeof content === "string") return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = `${turnId}:${block.tool_use_id}`;
      const running = tools.get(id);
      if (!running) continue;
      const text = resultText(block.content);
      const item: ToolItem = {
        ...running,
        status: block.is_error ? "failed" : "done",
        ...(text ? { output: truncateBytes(text, OUTPUT_MAX_BYTES) } : {}),
      };
      tools.set(id, item);
      out.push({ type: "item", item });
    }
  }

  function settleRunningTools(status: "done" | "failed", out: ProviderEvent[]) {
    for (const [id, item] of tools) {
      if (item.status !== "running") continue;
      const closed: ToolItem = { ...item, status };
      tools.set(id, closed);
      out.push({ type: "item", item: closed });
    }
  }

  function done(
    status: "completed" | "interrupted" | "failed",
    error: string | null,
    out: ProviderEvent[],
    failure?: TurnFailure,
  ): ProviderEvent[] {
    finished = true;
    out.push({
      type: "done",
      status,
      error,
      ...(lastChainUuid ? { nativeRef: lastChainUuid } : {}),
      ...(failure ? { failure } : {}),
    });
    return out;
  }

  function classifyFailed(error: string | null, resultSubtype?: string): TurnFailure | undefined {
    return asDoneFailure(
      classifyClaudeFailure({
        resultSubtype,
        errorText: error ?? undefined,
        rateLimit: lastRateLimit,
      }),
    );
  }

  function result(message: SDKResultMessage, out: ProviderEvent[]): ProviderEvent[] {
    out.push({ type: "usage", usage: usageOf(message) });
    if (message.subtype === "success" && !message.is_error) {
      settleRunningTools("done", out);
      return done("completed", null, out);
    }
    settleRunningTools("failed", out);
    const error = resultError(message, authFailed);
    return done("failed", error, out, classifyFailed(error, message.subtype));
  }

  return {
    noteRateLimit(info) {
      lastRateLimit = info;
    },

    push(message) {
      if (finished) return [];
      const out: ProviderEvent[] = [];
      const id = "session_id" in message ? message.session_id : undefined;
      if (typeof id === "string" && id !== "" && id !== sessionId) {
        sessionId = id;
        out.push({ type: "session", sessionId: id });
      }
      switch (message.type) {
        case "stream_event":
          stream(message, out);
          break;
        case "assistant":
          assistant(message, out);
          break;
        case "user":
          toolResults(message, out);
          break;
        case "rate_limit_event":
          lastRateLimit = message.rate_limit_info;
          break;
        case "result":
          return result(message, out);
        default:
          break;
      }
      return out;
    },

    finish(reason) {
      if (finished) return [];
      const out: ProviderEvent[] = [];
      const lastStderrLine =
        reason.kind === "ended"
          ? reason.stderr
              ?.split("\n")
              .map((line) => line.trim())
              .findLast((line) => line !== "")
          : undefined;
      if (reason.kind === "aborted") {
        settleRunningTools("failed", out);
        return done("interrupted", null, out);
      }
      if (reason.kind === "error") {
        settleRunningTools("failed", out);
        const error = errorText(reason.error);
        return done("failed", error, out, classifyFailed(error));
      }
      if (planProposed?.value) {
        settleRunningTools("done", out);
        if (lastStderrLine) return done("failed", clip(lastStderrLine, 300), out);
        return done("completed", null, out);
      }
      settleRunningTools("failed", out);
      return done(
        "failed",
        authFailed
          ? NOT_SIGNED_IN
          : lastStderrLine
            ? clip(lastStderrLine, 300)
            : "Claude Code stopped before finishing the turn.",
        out,
      );
    },
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() || "Claude Code failed.";
}

function usageOf(message: SDKResultMessage): Usage {
  const count = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const cached = message.usage.cache_read_input_tokens;
  return {
    inputTokens: count(message.usage.input_tokens),
    outputTokens: count(message.usage.output_tokens),
    ...(typeof cached === "number" ? { cachedInputTokens: count(cached) } : {}),
    ...(Number.isFinite(message.total_cost_usd) && message.total_cost_usd >= 0
      ? { costUsd: message.total_cost_usd }
      : {}),
  };
}

function resultError(message: SDKResultMessage, authFailed: boolean): string {
  if (authFailed) return NOT_SIGNED_IN;
  if (message.subtype === "success")
    return message.result.trim() || "Claude Code reported an error.";
  const detail = message.errors.join("; ").trim();
  if (detail) return detail;
  switch (message.subtype) {
    case "error_max_turns":
      return "Claude Code stopped after reaching its turn limit.";
    case "error_max_budget_usd":
      return "Claude Code stopped after reaching its spending limit.";
    default:
      return "Claude Code failed while working on the turn.";
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? [String((part as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}
