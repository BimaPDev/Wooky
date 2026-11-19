import type { ProviderEvent, TimelineItem, ToolKind } from "@wooky/contracts";
import { z } from "zod";
import { mapAcpToolKind } from "./permission.ts";
import { fitId, previewValue, truncateBytes, truncateTitle } from "./text.ts";

const OUTPUT_MAX_BYTES = 4 * 1024;

const KNOWN_IGNORED = new Set([
  "user_message_chunk",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "compaction_update",
  "compaction_summary_chunk",
]);

const ChunkUpdate = z.object({
  sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk"]),
  messageId: z.string().nullable().optional(),
  content: z.unknown().optional(),
});

const ToolUpdate = z
  .object({
    sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
    toolCallId: z.string().min(1),
    title: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    locations: z
      .array(z.object({ path: z.string() }).passthrough())
      .nullable()
      .optional(),
    content: z.array(z.unknown()).nullable().optional(),
    rawOutput: z.unknown().optional(),
  })
  .passthrough();

const PlanUpdate = z.object({
  sessionUpdate: z.literal("plan"),
  entries: z
    .array(
      z.object({
        content: z.string(),
        priority: z.string().optional(),
        status: z.string().optional(),
      }),
    )
    .min(1),
});

const UsageUpdate = z.object({
  sessionUpdate: z.literal("usage_update"),
  used: z.number().nonnegative(),
  cost: z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string(),
    })
    .nullable()
    .optional(),
});

interface ToolState {
  id: string;
  tool: ToolKind;
  title: string;
  name: string;
  status: "running" | "done" | "failed";
  output?: string;
  files?: string[];
}

interface OpenText {
  id: string;
  kind: "message" | "reasoning";
}

export class AcpTranslator {
  private readonly tools = new Map<string, ToolState>();
  private messageSeq = 0;
  private open: OpenText | null = null;
  private openKey: string | null = null;

  constructor(
    private readonly turnId: string,
    private readonly onDebug: (message: string) => void,
  ) {}

  push(update: unknown): ProviderEvent[] {
    const base = z.object({ sessionUpdate: z.string() }).passthrough().safeParse(update);
    if (!base.success) {
      this.onDebug("acp: ignored invalid session update");
      return [];
    }
    const kind = base.data.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") return this.chunk(update);
    if (kind === "tool_call" || kind === "tool_call_update") return this.tool(update);
    if (kind === "plan") return this.plan(update);
    if (kind === "usage_update") return this.usage(update);
    if (!KNOWN_IGNORED.has(kind)) this.onDebug(`acp: ignored session update ${kind.slice(0, 200)}`);
    return [];
  }

  private chunk(update: unknown): ProviderEvent[] {
    const parsed = ChunkUpdate.safeParse(update);
    if (!parsed.success) {
      this.onDebug("acp: ignored invalid session update");
      return [];
    }
    const text = textFromContent(parsed.data.content);
    if (text === null) return [];
    const role = parsed.data.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "message";
    const key = `${role}:${parsed.data.messageId ?? ""}`;
    if (!this.open || this.open.kind !== role || this.openKey !== key) {
      this.messageSeq += 1;
      const id = fitId(`${this.turnId}:${role === "message" ? "m" : "r"}${this.messageSeq}`);
      this.open = { id, kind: role };
      this.openKey = key;
      const item: TimelineItem =
        role === "message"
          ? { kind: "message", id, role: "assistant", text }
          : { kind: "reasoning", id, text };
      return [{ type: "item", item }];
    }
    return [{ type: "delta", itemId: this.open.id, text }];
  }

  private tool(update: unknown): ProviderEvent[] {
    const parsed = ToolUpdate.safeParse(update);
    if (!parsed.success) {
      this.onDebug("acp: ignored invalid session update");
      return [];
    }
    const body = parsed.data;
    const id = fitId(body.toolCallId, "tool");
    const previous = this.tools.get(id);
    const created = body.sessionUpdate === "tool_call" || !previous;
    const tool = body.kind ? mapAcpToolKind(body.kind) : (previous?.tool ?? "other");
    const title = truncateTitle(body.title || previous?.title || "Tool", "Tool");
    const name = body.name || previous?.name || body.toolCallId;
    const status = mapStatus(body.status) ?? previous?.status ?? "running";
    let output = previous?.output;
    if (body.content === null) output = undefined;
    else if (body.content !== undefined || body.rawOutput !== undefined) {
      output = toolPreview(body.content, body.rawOutput) ?? output;
    }
    let files = previous?.files;
    if (body.locations === null) files = undefined;
    else if (body.locations !== undefined) files = pathsOf(body.locations);
    const next: ToolState = {
      id,
      tool,
      title,
      name,
      status,
      ...(output ? { output } : {}),
      ...(files ? { files } : {}),
    };
    this.tools.set(id, next);
    if (created) this.open = null;
    const item: TimelineItem = {
      kind: "tool",
      id,
      tool,
      title,
      name,
      status,
      ...(output ? { output } : {}),
      ...(files && files.length > 0 ? { files } : {}),
    };
    return [{ type: "item", item }];
  }

  private plan(update: unknown): ProviderEvent[] {
    const parsed = PlanUpdate.safeParse(update);
    if (!parsed.success) {
      this.onDebug("acp: ignored invalid session update");
      return [];
    }
    const lines = parsed.data.entries
      .map((entry) => {
        const content = entry.content.trim();
        if (!content) return "";
        const mark =
          entry.status === "completed" ? "x" : entry.status === "in_progress" ? "-" : " ";
        const priority = entry.priority ? ` (${entry.priority})` : "";
        return `- [${mark}] ${content}${priority}`;
      })
      .filter((line) => line.length > 0);
    if (lines.length === 0) return [];
    this.open = null;
    return [{ type: "plan", itemId: fitId(`${this.turnId}:plan`), markdown: lines.join("\n") }];
  }

  private usage(update: unknown): ProviderEvent[] {
    const parsed = UsageUpdate.safeParse(update);
    if (!parsed.success) {
      this.onDebug("acp: ignored invalid session update");
      return [];
    }
    const used = Math.round(parsed.data.used);
    if (!Number.isFinite(used) || used < 0) return [];
    const cost = parsed.data.cost;
    const costUsd = cost && cost.currency.toUpperCase() === "USD" ? cost.amount : undefined;
    return [
      {
        type: "usage",
        usage: {
          inputTokens: used,
          outputTokens: 0,
          ...(costUsd !== undefined ? { costUsd } : {}),
        },
      },
    ];
  }
}

function mapStatus(status: string | null | undefined): ToolState["status"] | undefined {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "pending" || status === "in_progress") return "running";
  return undefined;
}

function textFromContent(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const record = content as Record<string, unknown>;
  if (record.type !== "text" || typeof record.text !== "string") return null;
  return record.text;
}

function pathsOf(locations: Array<{ path: string }>): string[] | undefined {
  const paths = locations.map((location) => location.path).filter((path) => path.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function toolPreview(content: unknown[] | undefined, rawOutput: unknown): string | undefined {
  const parts: string[] = [];
  if (content) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type === "content") {
        const text = textFromContent(record.content);
        if (text) parts.push(text);
      } else if (record.type === "diff" && typeof record.path === "string") {
        parts.push(record.path);
      }
    }
  }
  if (parts.length === 0 && rawOutput !== undefined) {
    const preview = previewValue(rawOutput, 4_000);
    if (preview) parts.push(preview);
  }
  if (parts.length === 0) return undefined;
  return truncateBytes(parts.join("\n"), OUTPUT_MAX_BYTES);
}
