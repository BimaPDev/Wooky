import type { ProviderEvent, TimelineItem, ToolKind } from "@age/contracts";
import {
  type CodexFileUpdateChange,
  type CodexThreadItem,
  type CodexTurnError,
  ErrorNotificationSchema,
  ItemLifecycleNotificationSchema,
  ItemTextDeltaNotificationSchema,
  ReasoningSummaryPartAddedNotificationSchema,
  ThreadStartedNotificationSchema,
  ThreadTokenUsageUpdatedNotificationSchema,
  TurnCompletedNotificationSchema,
} from "./protocol.ts";

const MAX_TITLE_CHARS = 120;
const MAX_OUTPUT_BYTES = 4096;
const MAX_ID_CHARS = 128;

export function normalizeId(raw: string, fallback = "item"): string {
  const trimmed = raw.trim();
  const base = trimmed.length > 0 ? trimmed : fallback;
  return base.length > MAX_ID_CHARS ? base.slice(0, MAX_ID_CHARS) : base;
}

export function truncateTitle(raw: string, fallback = "Tool"): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  const text = compact.length > 0 ? compact : fallback;
  if (text.length <= MAX_TITLE_CHARS) return text;
  return `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i);
    if (code === undefined) break;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}

export function truncateOutputPreview(raw: string): string {
  if (utf8ByteLength(raw) <= MAX_OUTPUT_BYTES) return raw;
  const prefix = "…\n";
  const budget = MAX_OUTPUT_BYTES - utf8ByteLength(prefix);
  const chars = Array.from(raw);
  let bytes = 0;
  let startIndex = chars.length;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] ?? "";
    const chBytes = utf8ByteLength(ch);
    if (bytes + chBytes > budget) break;
    bytes += chBytes;
    startIndex = i;
  }
  return prefix + chars.slice(startIndex).join("");
}

function deltaUsage(
  cumulative: UsageTotals,
  baseline: UsageTotals | null,
): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } {
  const base = baseline ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const inputTokens = Math.max(0, cumulative.inputTokens - base.inputTokens);
  const outputTokens = Math.max(0, cumulative.outputTokens - base.outputTokens);
  if (typeof cumulative.cachedInputTokens === "number") {
    const cachedInputTokens = Math.max(
      0,
      cumulative.cachedInputTokens - (base.cachedInputTokens ?? 0),
    );
    return { inputTokens, outputTokens, cachedInputTokens };
  }
  return { inputTokens, outputTokens };
}

function sanitizeUsage(raw: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, Math.trunc(raw.inputTokens)),
    outputTokens: Math.max(0, Math.trunc(raw.outputTokens)),
    ...(typeof raw.cachedInputTokens === "number" && raw.cachedInputTokens >= 0
      ? { cachedInputTokens: Math.trunc(raw.cachedInputTokens) }
      : {}),
  };
}

/** `total - last`, clamped at zero per field: the cumulative total before `last` was added. */
function subtractUsage(total: UsageTotals, last: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, total.inputTokens - last.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - last.outputTokens),
    ...(typeof total.cachedInputTokens === "number"
      ? { cachedInputTokens: Math.max(0, total.cachedInputTokens - (last.cachedInputTokens ?? 0)) }
      : {}),
  };
}

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  const cached =
    typeof a.cachedInputTokens === "number" || typeof b.cachedInputTokens === "number"
      ? (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0)
      : undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
  };
}

/** True when a counter went backwards, which means it was reset (compaction, a new thread). */
function isBelowBaseline(total: UsageTotals, baseline: UsageTotals): boolean {
  if (total.inputTokens < baseline.inputTokens) return true;
  if (total.outputTokens < baseline.outputTokens) return true;
  return (
    typeof total.cachedInputTokens === "number" &&
    typeof baseline.cachedInputTokens === "number" &&
    total.cachedInputTokens < baseline.cachedInputTokens
  );
}

function formatTurnError(err: CodexTurnError | null | undefined): string | null {
  if (!err) return null;
  const message = err.message.trim();
  const extra = err.additionalDetails?.trim();
  if (message && extra && !message.includes(extra)) return `${message}: ${extra}`;
  return message || extra || null;
}

function extractReasoningText(item: CodexThreadItem): string {
  const summaryParts = (item.summary ?? []).filter((part) => part.length > 0);
  if (summaryParts.length > 0) return summaryParts.join("\n\n");

  const contentParts: string[] = [];
  for (const entry of item.content ?? []) {
    if (typeof entry === "string" && entry.length > 0) {
      contentParts.push(entry);
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      "text" in entry &&
      typeof entry.text === "string" &&
      entry.text.length > 0
    ) {
      contentParts.push(entry.text);
    }
  }
  return contentParts.join("\n\n");
}

function extractMcpOutput(item: CodexThreadItem): string | undefined {
  if (item.error?.message) return truncateOutputPreview(item.error.message);
  if (!item.result) return undefined;

  const parts: string[] = [];
  for (const block of item.result.content ?? []) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  if (parts.length === 0 && item.result.structuredContent !== undefined) {
    parts.push(JSON.stringify(item.result.structuredContent));
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? truncateOutputPreview(joined) : undefined;
}

function extractDynamicToolOutput(item: CodexThreadItem): string | undefined {
  const parts: string[] = [];
  for (const block of item.contentItems ?? []) {
    if (
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? truncateOutputPreview(joined) : undefined;
}

function extractChangeFiles(changes: readonly CodexFileUpdateChange[] | undefined): string[] {
  if (!changes) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const change of changes) {
    const path = change.path.trim();
    if (path.length > 0 && !seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

function extractChangeDiff(changes: readonly CodexFileUpdateChange[] | undefined): string {
  if (!changes) return "";
  const diffs: string[] = [];
  for (const change of changes) {
    if (change.diff && change.diff.trim().length > 0) {
      diffs.push(change.diff);
    }
  }
  return diffs.join("\n");
}

function mapToolStatus(
  status: string | undefined,
  phase: "started" | "completed",
): "running" | "done" | "failed" {
  if (status === "failed" || status === "declined") return "failed";
  if (status === "completed") return "done";
  if (status === "inProgress") return "running";
  return phase === "started" ? "running" : "done";
}

export interface FileChangePreview {
  files: string[];
  diff: string;
}

/** Cumulative thread token totals, as reported by the app-server. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface CodexTranslatorOptions {
  /** Cumulative thread usage carried over from prior turns, subtracted so AGE sees per-turn deltas. */
  usageBaseline?: UsageTotals | null;
  /**
   * The turn continues an existing thread. With no baseline the thread's history
   * is unknown, so the first usage report seeds one instead of counting the whole
   * running total as this turn.
   */
  resumed?: boolean;
}

export interface CodexTranslator {
  bindSession(sessionId: string): ProviderEvent[];
  translateNotification(method: string, params: unknown): ProviderEvent[];
  finish(status: "completed" | "interrupted" | "failed", error: string | null): ProviderEvent[];
  isDone(): boolean;
  getLastError(): string | null;
  getCommandForItem(itemId: string): string | undefined;
  getFileChangeForItem(itemId: string): FileChangePreview | undefined;
  /** Latest cumulative thread total seen this turn, for carrying over as the next baseline. */
  getCumulativeUsage(): UsageTotals | null;
  /** Marks turn/start as sent. Usage seen before it only seeds the baseline. */
  beginTurn(): void;
  /**
   * Replaces the baseline when thread/resume answers with a different thread id.
   * Ignored once a usage report has already seeded the baseline from the server.
   */
  rebaseline(baseline: UsageTotals | null): void;
}

interface CommandState {
  command: string;
  output: string;
}

interface FileChangeState {
  files: string[];
  diff: string;
  output: string;
}

export function createCodexTranslator(options?: CodexTranslatorOptions): CodexTranslator {
  let emittedSessionId: string | null = null;
  let doneEmitted = false;
  let lastError: string | null = null;

  let usageBaseline = options?.usageBaseline ?? null;
  let usageNeedsSeed = options?.resumed === true && usageBaseline === null;
  let usageSeededByServer = false;
  let turnStarted = false;
  let latestCumulativeUsage: UsageTotals | null = null;
  let accumulatedLastUsage: UsageTotals | null = null;
  // Usage already emitted for this turn from counters that have since been reset. The
  // runner keeps only the latest usage event, so it must carry the whole turn.
  let carriedUsage: UsageTotals | null = null;
  let lastEmittedUsage: UsageTotals | null = null;

  const seenMessageIds = new Set<string>();
  const messageTexts = new Map<string, string>();

  const seenReasoningIds = new Set<string>();
  const reasoningTexts = new Map<string, string>();
  const pendingReasoningBreak = new Set<string>();

  const commandStates = new Map<string, CommandState>();
  const fileChangeStates = new Map<string, FileChangeState>();

  function emitSession(rawSessionId: string): ProviderEvent[] {
    if (doneEmitted) return [];
    const sessionId = rawSessionId.trim();
    if (sessionId.length === 0 || sessionId === emittedSessionId) return [];
    emittedSessionId = sessionId;
    return [{ type: "session", sessionId }];
  }

  function finish(
    status: "completed" | "interrupted" | "failed",
    error: string | null,
  ): ProviderEvent[] {
    if (doneEmitted) return [];
    doneEmitted = true;
    return [{ type: "done", status, error }];
  }

  function ensureMessageItem(id: string): ProviderEvent[] {
    if (seenMessageIds.has(id)) return [];
    seenMessageIds.add(id);
    messageTexts.set(id, "");
    return [{ type: "item", item: { kind: "message", id, role: "assistant", text: "" } }];
  }

  function ensureReasoningItem(id: string): ProviderEvent[] {
    if (seenReasoningIds.has(id)) return [];
    seenReasoningIds.add(id);
    reasoningTexts.set(id, "");
    return [{ type: "item", item: { kind: "reasoning", id, text: "" } }];
  }

  function translateItemLifecycle(
    item: CodexThreadItem,
    phase: "started" | "completed",
  ): ProviderEvent[] {
    const id = normalizeId(item.id);

    switch (item.type) {
      case "userMessage":
      case "hookPrompt":
      case "enteredReviewMode":
        return [];

      case "agentMessage": {
        const incoming = item.text ?? "";
        const accumulated = messageTexts.get(id) ?? "";
        const text =
          phase === "completed" && incoming.length === 0 && accumulated.length > 0
            ? accumulated
            : incoming;
        seenMessageIds.add(id);
        messageTexts.set(id, text);
        return [{ type: "item", item: { kind: "message", id, role: "assistant", text } }];
      }

      case "reasoning":
      case "plan": {
        const incoming = item.type === "plan" ? (item.text ?? "") : extractReasoningText(item);
        const accumulated = reasoningTexts.get(id) ?? "";
        const text =
          phase === "completed" && incoming.length === 0 && accumulated.length > 0
            ? accumulated
            : incoming;
        seenReasoningIds.add(id);
        reasoningTexts.set(id, text);
        pendingReasoningBreak.delete(id);
        return [{ type: "item", item: { kind: "reasoning", id, text } }];
      }

      case "commandExecution": {
        const prev = commandStates.get(id);
        const command = item.command ?? prev?.command ?? "";
        const rawOutput =
          item.aggregatedOutput !== undefined && item.aggregatedOutput !== null
            ? item.aggregatedOutput
            : (prev?.output ?? "");
        const output = rawOutput.length > 0 ? truncateOutputPreview(rawOutput) : "";
        commandStates.set(id, { command, output });

        let status = mapToolStatus(item.status, phase);
        if (typeof item.exitCode === "number" && item.exitCode !== 0) {
          status = "failed";
        }

        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "command",
          title: truncateTitle(command, "Run command"),
          name: "commandExecution",
          status,
          ...(output.length > 0 ? { output } : {}),
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "fileChange": {
        const prev = fileChangeStates.get(id);
        const files =
          item.changes !== undefined ? extractChangeFiles(item.changes) : (prev?.files ?? []);
        const diff =
          item.changes !== undefined ? extractChangeDiff(item.changes) : (prev?.diff ?? "");
        const outputSource = prev?.output && prev.output.length > 0 ? prev.output : diff;
        const output = outputSource.length > 0 ? truncateOutputPreview(outputSource) : "";
        fileChangeStates.set(id, { files, diff, output });

        const title =
          files.length > 0 ? truncateTitle(`Edit ${files.join(", ")}`, "Edit files") : "Edit files";
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "edit",
          title,
          name: "fileChange",
          status: mapToolStatus(item.status, phase),
          ...(files.length > 0 ? { files } : {}),
          ...(output.length > 0 ? { output } : {}),
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "mcpToolCall": {
        const server = item.server ?? "mcp";
        const toolName = item.tool ?? "tool";
        const output = extractMcpOutput(item);
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "other",
          title: truncateTitle(`${server}: ${toolName}`, "MCP tool"),
          name: `mcp:${server}/${toolName}`,
          status: mapToolStatus(item.status, phase),
          ...(output !== undefined ? { output } : {}),
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "dynamicToolCall": {
        const toolName = item.tool ?? "tool";
        const fullName = item.namespace ? `${item.namespace}/${toolName}` : toolName;
        const output = extractDynamicToolOutput(item);
        let status = mapToolStatus(item.status, phase);
        if (item.success === false) status = "failed";
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "other",
          title: truncateTitle(fullName, "Tool"),
          name: fullName,
          status,
          ...(output !== undefined ? { output } : {}),
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "webSearch": {
        const query = item.query?.trim() ?? "";
        const title =
          query.length > 0 ? truncateTitle(`Web search: ${query}`, "Web search") : "Web search";
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "web",
          title,
          name: "webSearch",
          status: phase === "started" ? "running" : "done",
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "collabToolCall":
      case "collabAgentToolCall": {
        const toolName = item.tool ?? "agent";
        const label =
          item.prompt && item.prompt.trim().length > 0 ? `${toolName}: ${item.prompt}` : toolName;
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "task",
          title: truncateTitle(label, "Agent task"),
          name: toolName,
          status: mapToolStatus(item.status, phase),
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "imageView": {
        const filePath = item.path?.trim() ?? "";
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: "read",
          title: truncateTitle(filePath ? `View ${filePath}` : "View image", "View image"),
          name: "imageView",
          status: phase === "started" ? "running" : "done",
          ...(filePath.length > 0 ? { files: [filePath] } : {}),
        };
        return [{ type: "item", item: timelineItem }];
      }

      case "exitedReviewMode": {
        if (phase !== "completed" || !item.review || item.review.trim().length === 0) return [];
        return [
          { type: "item", item: { kind: "message", id, role: "assistant", text: item.review } },
        ];
      }

      case "contextCompaction": {
        if (phase !== "completed") return [];
        return [
          {
            type: "item",
            item: { kind: "notice", id, text: "Compacted conversation context." },
          },
        ];
      }

      default: {
        const fallbackKind: ToolKind = item.type.toLowerCase().includes("search")
          ? "search"
          : "other";
        const timelineItem: TimelineItem = {
          kind: "tool",
          id,
          tool: fallbackKind,
          title: truncateTitle(item.type, "Tool"),
          name: item.type,
          status: mapToolStatus(item.status, phase),
        };
        return [{ type: "item", item: timelineItem }];
      }
    }
  }

  function translateNotification(method: string, params: unknown): ProviderEvent[] {
    if (doneEmitted) return [];

    switch (method) {
      case "thread/started": {
        const parsed = ThreadStartedNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        return emitSession(parsed.data.thread.id);
      }

      case "item/started": {
        const parsed = ItemLifecycleNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        return translateItemLifecycle(parsed.data.item, "started");
      }

      case "item/completed": {
        const parsed = ItemLifecycleNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        return translateItemLifecycle(parsed.data.item, "completed");
      }

      case "item/agentMessage/delta": {
        const parsed = ItemTextDeltaNotificationSchema.safeParse(params);
        if (!parsed.success || parsed.data.delta.length === 0) return [];
        const id = normalizeId(parsed.data.itemId);
        const events = ensureMessageItem(id);
        messageTexts.set(id, (messageTexts.get(id) ?? "") + parsed.data.delta);
        events.push({ type: "delta", itemId: id, text: parsed.data.delta });
        return events;
      }

      case "item/reasoning/summaryPartAdded": {
        const parsed = ReasoningSummaryPartAddedNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        const id = normalizeId(parsed.data.itemId);
        if (parsed.data.summaryIndex > 0 && (reasoningTexts.get(id) ?? "").length > 0) {
          pendingReasoningBreak.add(id);
        }
        return [];
      }

      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/plan/delta": {
        const parsed = ItemTextDeltaNotificationSchema.safeParse(params);
        if (!parsed.success || parsed.data.delta.length === 0) return [];
        const id = normalizeId(parsed.data.itemId);
        const events = ensureReasoningItem(id);
        const prev = reasoningTexts.get(id) ?? "";
        const needsBreak = pendingReasoningBreak.delete(id) && !prev.endsWith("\n\n");
        const chunk = needsBreak ? `\n\n${parsed.data.delta}` : parsed.data.delta;
        reasoningTexts.set(id, prev + chunk);
        events.push({ type: "delta", itemId: id, text: chunk });
        return events;
      }

      case "item/commandExecution/outputDelta": {
        const parsed = ItemTextDeltaNotificationSchema.safeParse(params);
        if (!parsed.success || parsed.data.delta.length === 0) return [];
        const id = normalizeId(parsed.data.itemId);
        const prev = commandStates.get(id);
        const command = prev?.command ?? "";
        const output = truncateOutputPreview((prev?.output ?? "") + parsed.data.delta);
        commandStates.set(id, { command, output });
        return [
          {
            type: "item",
            item: {
              kind: "tool",
              id,
              tool: "command",
              title: truncateTitle(command, "Run command"),
              name: "commandExecution",
              status: "running",
              output,
            },
          },
        ];
      }

      case "item/fileChange/outputDelta": {
        const parsed = ItemTextDeltaNotificationSchema.safeParse(params);
        if (!parsed.success || parsed.data.delta.length === 0) return [];
        const id = normalizeId(parsed.data.itemId);
        const prev = fileChangeStates.get(id);
        const files = prev?.files ?? [];
        const diff = prev?.diff ?? "";
        const output = truncateOutputPreview((prev?.output ?? "") + parsed.data.delta);
        fileChangeStates.set(id, { files, diff, output });
        const title =
          files.length > 0 ? truncateTitle(`Edit ${files.join(", ")}`, "Edit files") : "Edit files";
        return [
          {
            type: "item",
            item: {
              kind: "tool",
              id,
              tool: "edit",
              title,
              name: "fileChange",
              status: "running",
              ...(files.length > 0 ? { files } : {}),
              output,
            },
          },
        ];
      }

      case "thread/tokenUsage/updated": {
        const parsed = ThreadTokenUsageUpdatedNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        const { total: rawTotal, last: rawLast } = parsed.data.tokenUsage;
        const total = rawTotal ? sanitizeUsage(rawTotal) : null;
        const last = rawLast ? sanitizeUsage(rawLast) : null;

        if (!turnStarted) {
          // Reported while the thread loads (thread/resume): the thread's running
          // total before this turn. It becomes the baseline and is not usage.
          if (total) {
            usageBaseline = total;
            usageNeedsSeed = false;
            usageSeededByServer = true;
            latestCumulativeUsage = total;
          }
          return [];
        }

        if (total) {
          const previous = latestCumulativeUsage ?? usageBaseline;
          if (usageNeedsSeed) {
            usageBaseline = last ? subtractUsage(total, last) : total;
            usageNeedsSeed = false;
          } else if (previous && isBelowBaseline(total, previous)) {
            // The counter restarted mid-turn (below the last total seen, or the
            // baseline before any): keep what this turn already reported.
            carriedUsage = lastEmittedUsage;
            usageBaseline = last ? subtractUsage(total, last) : null;
          }
          latestCumulativeUsage = total;
          const delta = deltaUsage(total, usageBaseline);
          const emitted = carriedUsage ? addUsage(carriedUsage, delta) : delta;
          lastEmittedUsage = emitted;
          return [{ type: "usage", usage: emitted }];
        }

        if (last) {
          // `last` is one step's usage: sum the steps for the turn, and rebuild the
          // thread total from the baseline when there is one to build on.
          accumulatedLastUsage = accumulatedLastUsage ? addUsage(accumulatedLastUsage, last) : last;
          if (!usageNeedsSeed) {
            latestCumulativeUsage = addUsage(
              usageBaseline ?? { inputTokens: 0, outputTokens: 0 },
              accumulatedLastUsage,
            );
          }
          return [{ type: "usage", usage: accumulatedLastUsage }];
        }
        return [];
      }

      case "error": {
        const parsed = ErrorNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        const formatted = formatTurnError(parsed.data.error);
        if (formatted) lastError = formatted;
        return [];
      }

      case "turn/completed": {
        const parsed = TurnCompletedNotificationSchema.safeParse(params);
        if (!parsed.success) return [];
        const { turn } = parsed.data;
        if (turn.status === "inProgress") return [];
        if (turn.status === "completed") return finish("completed", null);
        if (turn.status === "interrupted") {
          return finish("interrupted", formatTurnError(turn.error));
        }
        return finish("failed", formatTurnError(turn.error) ?? lastError ?? "Codex turn failed.");
      }

      default:
        return [];
    }
  }

  return {
    bindSession: emitSession,
    translateNotification,
    finish,
    isDone: () => doneEmitted,
    getLastError: () => lastError,
    getCommandForItem: (itemId) => commandStates.get(normalizeId(itemId))?.command,
    getFileChangeForItem: (itemId) => {
      const entry = fileChangeStates.get(normalizeId(itemId));
      return entry ? { files: entry.files, diff: entry.diff } : undefined;
    },
    getCumulativeUsage: () => latestCumulativeUsage,
    beginTurn: () => {
      turnStarted = true;
    },
    rebaseline: (baseline) => {
      if (usageSeededByServer) return;
      usageBaseline = baseline;
      usageNeedsSeed = baseline === null;
    },
  };
}
