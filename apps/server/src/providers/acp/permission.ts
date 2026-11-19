import type { ApprovalRequest, InteractionMode, RuntimeMode, ToolKind } from "@age/contracts";
import { z } from "zod";
import { fitId, previewValue, truncateBytes, truncateTitle } from "./text.ts";

const ALLOW_KINDS = ["allow_once", "allow_always"];
const DENY_KINDS = ["reject_once", "reject_always"];

const ToolCallShape = z
  .object({
    toolCallId: z.string().optional(),
    title: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    rawInput: z.unknown().optional(),
    content: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

const OptionShape = z.object({
  optionId: z.string().min(1),
  name: z.string().optional(),
  kind: z.string(),
});

const PermissionParams = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    options: z.array(OptionShape).min(1),
    toolCall: ToolCallShape.optional(),
    subject: z
      .object({
        type: z.string(),
        toolCall: ToolCallShape.optional(),
        command: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface PermissionOption {
  optionId: string;
  kind: string;
  name?: string;
}

export interface ParsedPermission {
  request: ApprovalRequest;
  options: PermissionOption[];
}

export function mapAcpToolKind(kind: string | null | undefined): ToolKind {
  switch (kind) {
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "command";
    case "fetch":
      return "web";
    default:
      return "other";
  }
}

/** Full skips the card. Auto-edits skips file edits. Plan mode always asks. */
export function shouldAsk(input: {
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  tool: ToolKind;
}): boolean {
  if (input.interactionMode === "plan") return true;
  if (input.runtimeMode === "full") return false;
  if (input.runtimeMode === "auto-edits" && input.tool === "edit") return false;
  return true;
}

export function selectOption(
  decision: "allow" | "deny",
  options: readonly PermissionOption[],
): string | null {
  const preferred = decision === "allow" ? ALLOW_KINDS : DENY_KINDS;
  for (const kind of preferred) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  const needle = decision === "allow" ? "allow" : "reject";
  return options.find((option) => option.kind.includes(needle))?.optionId ?? null;
}

export function permissionResult(
  decision: "allow" | "deny" | "cancel",
  options: readonly PermissionOption[],
): { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } } {
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const optionId = selectOption(decision, options);
  if (!optionId) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId } };
}

export function parsePermission(params: unknown, rpcId: string | number): ParsedPermission | null {
  const parsed = PermissionParams.safeParse(params);
  if (!parsed.success) return null;
  const body = parsed.data;
  const subject = body.subject;
  const toolCall = subject?.type === "tool_call" ? subject.toolCall : body.toolCall;
  const command = subject?.type === "command" ? subject.command : undefined;
  const tool = command ? "command" : mapAcpToolKind(toolCall?.kind);
  const title = truncateTitle(
    body.title || toolCall?.title || command || "Permission",
    "Permission",
  );
  const detailSource =
    body.description ||
    command ||
    previewValue(toolCall?.rawInput) ||
    "The agent is asking to continue.";
  const diff = diffFromContent(toolCall?.content);
  const requestId = fitId(toolCall?.toolCallId || `perm-${String(rpcId)}`, "perm");
  return {
    request: {
      requestId,
      tool,
      title,
      detail: truncateBytes(detailSource, 2_000),
      ...(diff ? { diff } : {}),
    },
    options: body.options.map((option) => ({
      optionId: option.optionId,
      kind: option.kind,
      ...(option.name ? { name: option.name } : {}),
    })),
  };
}

function diffFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "diff" || typeof record.path !== "string") continue;
    const oldText = typeof record.oldText === "string" ? record.oldText : "";
    const newText = typeof record.newText === "string" ? record.newText : "";
    if (oldText.length + newText.length > 4_000) {
      blocks.push(`--- ${record.path}\n+++ ${record.path}\n(diff truncated)`);
      continue;
    }
    const removed = oldText.split("\n").map((line) => `-${line}`);
    const added = newText.split("\n").map((line) => `+${line}`);
    blocks.push([`--- ${record.path}`, `+++ ${record.path}`, ...removed, ...added].join("\n"));
  }
  if (blocks.length === 0) return undefined;
  return truncateBytes(blocks.join("\n"), 4_000);
}
