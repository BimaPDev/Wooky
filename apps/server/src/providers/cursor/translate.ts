import type { ProviderEvent, ToolKind, TurnFailure, Usage } from "@age/contracts";
import { asDoneFailure } from "../failure.ts";
import { workspaceRelative } from "../paths.ts";
import { classifyCursorFailure } from "./classify.ts";

const OUTPUT_PREVIEW_MAX = 4 * 1024;

const previewEncoder = new TextEncoder();
const previewDecoder = new TextDecoder();

function truncateUtf8Bytes(text: string, maxBytes: number, marker = "…"): string {
  if (previewEncoder.encode(text).length <= maxBytes) return text;
  const room = maxBytes - previewEncoder.encode(marker).length;
  const cut = previewDecoder
    .decode(previewEncoder.encode(text).slice(0, Math.max(0, room)))
    .replace(/�+$/u, "");
  return cut + marker;
}

export type CursorStreamEvent = Record<string, unknown>;

export class CursorTranslator {
  private sessionEmitted = false;
  private doneEmitted = false;

  private messageItemId: string | null = null;
  private messageText = "";
  private messageSeq = 0;

  private reasoningItemId: string | null = null;
  private reasoningText = "";
  private reasoningSeq = 0;

  private readonly tools = new Map<string, string>();

  constructor(
    private readonly turnId: string,
    private readonly cwd: string,
  ) {}

  translate(event: CursorStreamEvent): ProviderEvent[] {
    if (this.doneEmitted) return [];

    const out: ProviderEvent[] = [];
    const sessionId = typeof event.session_id === "string" ? event.session_id : null;
    if (sessionId && !this.sessionEmitted) {
      this.sessionEmitted = true;
      out.push({ type: "session", sessionId });
    }

    switch (event.type) {
      case "thinking":
        out.push(...this.onThinking(event));
        break;
      case "assistant":
        out.push(...this.onAssistant(event));
        break;
      case "tool_call":
        out.push(...this.onToolCall(event));
        break;
      case "result":
        out.push(...this.onResult(event));
        break;
      default:
        break;
    }

    return out;
  }

  finish(
    exitCode: number | null,
    exitSignal: string | null,
    stderrTail: string | null,
    aborted: boolean,
  ): ProviderEvent[] {
    if (this.doneEmitted) return [];
    this.doneEmitted = true;

    if (aborted) {
      return [{ type: "done", status: "interrupted", error: null }];
    }
    if (exitSignal) {
      const error = stderrTail ?? `Process exited on signal ${exitSignal}`;
      return [failedDone(error, { stderr: stderrTail ?? undefined, exitCode })];
    }
    if (exitCode !== null && exitCode !== 0) {
      const error = stderrTail ?? `Process exited with code ${exitCode}`;
      return [failedDone(error, { stderr: stderrTail ?? undefined, exitCode })];
    }
    if (exitCode === 0) {
      return [{ type: "done", status: "completed", error: null }];
    }
    const error = stderrTail ?? "Process exited unexpectedly";
    return [failedDone(error, { stderr: stderrTail ?? undefined, exitCode })];
  }

  private closeMessageSegment(): void {
    this.messageItemId = null;
    this.messageText = "";
  }

  private closeReasoningSegment(): void {
    this.reasoningItemId = null;
    this.reasoningText = "";
  }

  private onThinking(event: CursorStreamEvent): ProviderEvent[] {
    if (event.subtype !== "delta" || typeof event.text !== "string") return [];
    this.closeMessageSegment();
    const text = event.text;

    if (!this.reasoningItemId) {
      this.reasoningSeq += 1;
      this.reasoningItemId = `${this.turnId}:reason:${this.reasoningSeq}`;
      this.reasoningText = text;
      return [
        {
          type: "item",
          item: { kind: "reasoning", id: this.reasoningItemId, text },
        },
      ];
    }

    this.reasoningText += text;
    return [{ type: "delta", itemId: this.reasoningItemId, text }];
  }

  private onAssistant(event: CursorStreamEvent): ProviderEvent[] {
    const text = extractAssistantText(event);
    if (text === null) return [];
    this.closeReasoningSegment();

    const hasModelCallId = typeof event.model_call_id === "string";
    const hasTimestamp = typeof event.timestamp_ms === "number";
    const isFullSegment =
      hasModelCallId ||
      (!hasTimestamp &&
        (text === this.messageText ||
          (this.messageText.length > 0 && text.startsWith(this.messageText))));

    if (isFullSegment) {
      if (text === this.messageText) return [];

      if (!this.messageItemId) {
        this.messageSeq += 1;
        this.messageItemId = `${this.turnId}:msg:${this.messageSeq}`;
      }

      this.messageText = text;
      return [
        {
          type: "item",
          item: {
            kind: "message",
            id: this.messageItemId,
            role: "assistant",
            text,
          },
        },
      ];
    }

    if (!this.messageItemId) {
      this.messageSeq += 1;
      this.messageItemId = `${this.turnId}:msg:${this.messageSeq}`;
      this.messageText = text;
      return [
        {
          type: "item",
          item: {
            kind: "message",
            id: this.messageItemId,
            role: "assistant",
            text,
          },
        },
      ];
    }

    this.messageText += text;
    return [{ type: "delta", itemId: this.messageItemId, text }];
  }

  private onToolCall(event: CursorStreamEvent): ProviderEvent[] {
    const subtype = event.subtype;
    const callId = typeof event.call_id === "string" ? event.call_id : null;
    if (!callId) return [];

    const toolCall = event.tool_call as Record<string, unknown> | undefined;
    if (!toolCall) return [];

    if (subtype === "started") {
      this.closeMessageSegment();
      this.closeReasoningSegment();

      const info = classifyToolCall(toolCall, this.cwd);
      const itemId = `${this.turnId}:tool:${sanitizeCallId(callId)}`;
      this.tools.set(callId, itemId);
      return [
        {
          type: "item",
          item: {
            kind: "tool",
            id: itemId,
            tool: info.kind,
            title: info.title,
            name: info.name,
            status: "running",
            files: info.files,
          },
        },
      ];
    }

    if (subtype === "completed") {
      const itemId = this.tools.get(callId);
      if (!itemId) return [];
      const info = classifyToolCall(toolCall, this.cwd);
      const { output, failed } = extractToolOutput(toolCall);
      return [
        {
          type: "item",
          item: {
            kind: "tool",
            id: itemId,
            tool: info.kind,
            title: info.title,
            name: info.name,
            status: failed ? "failed" : "done",
            output,
            files: info.files,
          },
        },
      ];
    }

    return [];
  }

  private onResult(event: CursorStreamEvent): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    const usage = parseUsage(event.usage);
    if (usage) out.push({ type: "usage", usage });

    const isError = event.is_error === true || event.subtype === "error";
    const errorText = isError && typeof event.result === "string" ? event.result : null;

    this.doneEmitted = true;
    if (isError) {
      out.push(
        failedDone(errorText, {
          errorText: errorText ?? undefined,
        }),
      );
    } else {
      out.push({ type: "done", status: "completed", error: null });
    }
    return out;
  }
}

function failedDone(
  error: string | null,
  input: { errorText?: string; stderr?: string; exitCode?: number | null },
): Extract<ProviderEvent, { type: "done" }> {
  const failure: TurnFailure | undefined = asDoneFailure(classifyCursorFailure(input));
  return {
    type: "done",
    status: "failed",
    error,
    ...(failure ? { failure } : {}),
  };
}

function extractAssistantText(event: CursorStreamEvent): string | null {
  const message = event.message as
    { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (!message?.content) return null;
  const parts = message.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.length > 0 ? parts.join("") : null;
}

function sanitizeCallId(callId: string): string {
  return callId.replace(/\s+/g, "_").slice(0, 120);
}

function classifyToolCall(
  toolCall: Record<string, unknown>,
  cwd: string,
): {
  kind: ToolKind;
  name: string;
  title: string;
  files?: string[];
} {
  const keys = Object.keys(toolCall).filter((k) => k.endsWith("ToolCall"));
  const name = keys[0] ?? Object.keys(toolCall)[0] ?? "unknown";
  const inner = toolCall[name] as Record<string, unknown> | undefined;
  const args = inner?.args as Record<string, unknown> | undefined;

  if (name === "readToolCall") {
    const path = typeof args?.path === "string" ? workspaceRelative(args.path, cwd) : "?";
    return { kind: "read", name, title: `Read ${path}` };
  }
  if (name === "shellToolCall") {
    const cmd = typeof args?.command === "string" ? args.command : "?";
    return { kind: "command", name, title: truncate(cmd, 120) };
  }
  if (
    name === "editToolCall" ||
    name === "writeToolCall" ||
    name === "strReplaceToolCall" ||
    name === "applyPatchToolCall"
  ) {
    const raw =
      typeof args?.path === "string"
        ? args.path
        : typeof args?.file_path === "string"
          ? args.file_path
          : "?";
    const path = raw === "?" ? raw : workspaceRelative(raw, cwd);
    return { kind: "edit", name, title: `Edit ${path}`, files: [path] };
  }
  if (name === "grepToolCall" || name === "searchToolCall" || name === "globToolCall") {
    const pattern =
      typeof args?.pattern === "string"
        ? args.pattern
        : typeof args?.query === "string"
          ? args.query
          : "?";
    return { kind: "search", name, title: `Search ${truncate(pattern, 80)}` };
  }
  if (name === "webToolCall" || name === "webFetchToolCall") {
    const url = typeof args?.url === "string" ? args.url : "?";
    return { kind: "web", name, title: truncate(url, 120) };
  }
  if (name === "taskToolCall") {
    return { kind: "task", name, title: "Task" };
  }
  return { kind: "other", name, title: name };
}

function extractToolOutput(toolCall: Record<string, unknown>): {
  output: string | undefined;
  failed: boolean;
} {
  const keys = Object.keys(toolCall).filter((k) => k.endsWith("ToolCall"));
  const name = keys[0] ?? Object.keys(toolCall)[0];
  if (!name) return { output: undefined, failed: false };

  const inner = toolCall[name] as Record<string, unknown> | undefined;
  const result = inner?.result as Record<string, unknown> | undefined;
  if (!result) return { output: undefined, failed: false };

  if (result.rejected || result.error) {
    return { output: previewJson(result), failed: true };
  }

  if (result.success) {
    const success = result.success as Record<string, unknown>;

    if (name === "shellToolCall") {
      const exitCode = success.exitCode;
      const failed = typeof exitCode === "number" && exitCode !== 0;
      let output: string | undefined;
      if (typeof success.interleavedOutput === "string") {
        output = truncatePreview(success.interleavedOutput);
      } else {
        const stdout = typeof success.stdout === "string" ? success.stdout : "";
        const stderr = typeof success.stderr === "string" ? success.stderr : "";
        const combined = stdout + stderr;
        output = combined.length > 0 ? truncatePreview(combined) : undefined;
      }
      return { output, failed };
    }

    if (typeof success.content === "string") {
      return { output: truncatePreview(success.content), failed: false };
    }
    if (typeof success.output === "string") {
      return { output: truncatePreview(success.output), failed: false };
    }
    return { output: previewJson(success), failed: false };
  }

  return { output: previewJson(result), failed: false };
}

function previewJson(value: unknown): string {
  return truncatePreview(JSON.stringify(value));
}

function parseUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const inputTokens = typeof u.inputTokens === "number" ? u.inputTokens : null;
  const outputTokens = typeof u.outputTokens === "number" ? u.outputTokens : null;
  if (inputTokens === null || outputTokens === null) return null;

  const usage: Usage = { inputTokens, outputTokens };
  if (typeof u.cacheReadTokens === "number") {
    usage.cachedInputTokens = u.cacheReadTokens;
  }
  return usage;
}

function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(0, maxChars - 1) + "…";
}

function truncatePreview(s: string): string {
  return truncateUtf8Bytes(s, OUTPUT_PREVIEW_MAX);
}
