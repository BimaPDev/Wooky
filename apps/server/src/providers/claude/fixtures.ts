import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultError,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Hand-written SDK messages for tests. The SDK types carry dozens of fields a
 * translator never reads, so each builder fills only the fields the adapter
 * reads and casts the result to the SDK type. The casts are unchecked: a renamed
 * or removed SDK field will not fail here, only in the adapter's own typecheck.
 */
const SESSION = "session-1";
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}` as const;

type Streamed = SDKPartialAssistantMessage["event"];
type AssistantBlock = SDKAssistantMessage["message"]["content"][number];

export function init(sessionId = SESSION): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: uuid(),
    cwd: "/work",
    model: "claude-sonnet-5",
  } as unknown as SDKSystemMessage;
}

function stream(event: unknown): SDKPartialAssistantMessage {
  return {
    type: "stream_event",
    event: event as Streamed,
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SESSION,
  };
}

export const messageStart = (id: string) => stream({ type: "message_start", message: { id } });

export const blockStart = (index: number, type: "text" | "thinking") =>
  stream({
    type: "content_block_start",
    index,
    content_block: type === "text" ? { type, text: "" } : { type, thinking: "", signature: "" },
  });

export const textDelta = (index: number, text: string) =>
  stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } });

export const thinkingDelta = (index: number, thinking: string) =>
  stream({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } });

export function assistant(
  messageId: string,
  content: unknown[],
  extra: { error?: SDKAssistantMessage["error"]; parent?: string } = {},
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: content as AssistantBlock[],
    },
    parent_tool_use_id: extra.parent ?? null,
    ...(extra.error ? { error: extra.error } : {}),
    uuid: uuid(),
    session_id: SESSION,
  } as unknown as SDKAssistantMessage;
}

export const text = (value: string) => ({ type: "text", text: value, citations: null });
export const thinking = (value: string) => ({
  type: "thinking",
  thinking: value,
  signature: "sig",
});
export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "tool_use",
  id,
  name,
  input,
});

export function toolResult(
  toolUseId: string,
  content: string | { type: "text"; text: string }[],
  isError = false,
): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SESSION,
  };
}

export function resultSuccess(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 30 },
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKResultSuccess;
}

export function resultError(
  subtype: SDKResultError["subtype"],
  errors: string[] = [],
): SDKResultError {
  return {
    type: "result",
    subtype,
    is_error: true,
    errors,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { input_tokens: 5, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    session_id: SESSION,
  } as unknown as SDKResultError;
}

export function rateLimitEvent(info: SDKRateLimitInfo): SDKRateLimitEvent {
  return {
    type: "rate_limit_event",
    rate_limit_info: info,
    uuid: uuid(),
    session_id: SESSION,
  } as unknown as SDKRateLimitEvent;
}

export function taskNotification(taskId = "task-1"): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status: "stopped",
    output_file: "",
    summary: "Background shell command didn't finish before the previous session ended",
    uuid: uuid(),
    session_id: SESSION,
  } as unknown as SDKMessage;
}

/** The single prompt message the adapter hands to `query`, read back for assertions. */
export async function sentPrompt(prompt: unknown): Promise<{ text: string; uuid: string }> {
  for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
    const content = message.message.content;
    const body =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return { text: body, uuid: message.uuid ?? "" };
  }
  throw new Error("no prompt message");
}

export type { SDKMessage };
