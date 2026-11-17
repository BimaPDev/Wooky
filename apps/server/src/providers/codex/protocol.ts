/**
 * Codex app-server v2 protocol schemas and runtime-mode mappings.
 *
 * Implemented against official OpenAI Codex documentation and generated v2 schemas:
 * - https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
 * - https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript/v2
 * - https://developers.openai.com/codex/models
 *
 * Protocol notes / assumptions:
 * - Transport is newline-delimited JSON-RPC over stdio (`codex app-server`), where Codex omits
 *   the `"jsonrpc": "2.0"` field on the wire and `initialized` is sent without `params`.
 * - RuntimeMode maps to `approvalPolicy` (`AskForApproval`) + `sandbox` (`SandboxMode`) on
 *   thread start/resume and `sandboxPolicy` (`SandboxPolicy`) on `turn/start`, with
 *   `approvalsReviewer: "user"`:
 *   - "approve"    -> approvalPolicy: "untrusted", sandbox: "read-only" / readOnly
 *   - "auto-edits" -> approvalPolicy: "untrusted", sandbox: "workspace-write" / workspaceWrite
 *   - "full"       -> approvalPolicy: "never",     sandbox: "danger-full-access" / dangerFullAccess
 * - In Codex `safety.rs`, `approvalPolicy: "untrusted"` still emits `item/fileChange/requestApproval`
 *   even inside `workspace-write` (while `"on-request"` would skip command prompts in sandboxed turns).
 *   To honor AGE's `"auto-edits"` contract ("file edits run, commands still ask"), the adapter uses
 *   `"untrusted"` so commands prompt, and auto-accepts non-escalated (`!grantRoot`) fileChange prompts
 *   when `runtimeMode === "auto-edits"`. Under `"untrusted"`, Codex still auto-allows its built-in
 *   read-only command safelist without issuing an approval request.
 * - `codex --version` verifies CLI installation without network or quota; authentication cannot be
 *   confirmed without starting an app-server/account check, so `probe()` reports `authenticated: null`.
 */
import { z } from "zod";
import type { RuntimeMode } from "@age/contracts";

export const JsonRpcId = z.union([z.number().int(), z.string()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

export const JsonRpcErrorPayload = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorPayload = z.infer<typeof JsonRpcErrorPayload>;

const JsonRpcServerRequestEnvelope = z.object({
  id: JsonRpcId,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const JsonRpcNotificationEnvelope = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const JsonRpcSuccessResponseEnvelope = z.object({
  id: JsonRpcId,
  result: z.unknown(),
});

const JsonRpcErrorResponseEnvelope = z.object({
  id: JsonRpcId,
  error: JsonRpcErrorPayload,
});

export type JsonRpcIncomingMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "response"; id: JsonRpcId; result: unknown }
  | { kind: "error"; id: JsonRpcId; error: JsonRpcErrorPayload };

const RawRecord = z.record(z.string(), z.unknown());

export function parseJsonRpcMessage(raw: unknown): JsonRpcIncomingMessage {
  const obj = RawRecord.parse(raw);
  if ("method" in obj && typeof obj.method === "string") {
    if ("id" in obj && obj.id !== undefined && obj.id !== null) {
      const parsed = JsonRpcServerRequestEnvelope.parse(obj);
      return {
        kind: "request",
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      };
    }
    const parsed = JsonRpcNotificationEnvelope.parse(obj);
    return {
      kind: "notification",
      method: parsed.method,
      params: parsed.params,
    };
  }
  if ("error" in obj && obj.error !== undefined) {
    const parsed = JsonRpcErrorResponseEnvelope.parse(obj);
    return { kind: "error", id: parsed.id, error: parsed.error };
  }
  const parsed = JsonRpcSuccessResponseEnvelope.parse(obj);
  return { kind: "response", id: parsed.id, result: parsed.result };
}

export type CodexAskForApproval = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalsReviewer = "user";

export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: "dangerFullAccess" };

export interface CodexRuntimeSettings {
  approvalPolicy: CodexAskForApproval;
  approvalsReviewer: CodexApprovalsReviewer;
  sandbox: CodexSandboxMode;
  sandboxPolicy: CodexSandboxPolicy;
}

export function runtimeModeToCodexSettings(
  runtimeMode: RuntimeMode,
  cwd: string,
): CodexRuntimeSettings {
  switch (runtimeMode) {
    case "approve":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
    case "auto-edits":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "full":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

export const InitializeResponseSchema = z.object({
  userAgent: z.string().optional(),
});

export const ThreadEnvelopeResponseSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
  }),
});

export const TurnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string().min(1),
    status: z.string().optional(),
  }),
});

export const ThreadStartedNotificationSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
  }),
});

export const TurnStartedNotificationSchema = z.object({
  threadId: z.string().optional(),
  turn: z.object({
    id: z.string().min(1),
    status: z.string().optional(),
  }),
});

export const TurnErrorSchema = z.object({
  message: z.string(),
  additionalDetails: z.string().nullable().optional(),
});
export type CodexTurnError = z.infer<typeof TurnErrorSchema>;

export const TurnCompletedNotificationSchema = z.object({
  threadId: z.string().optional(),
  turn: z.object({
    id: z.string(),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: TurnErrorSchema.nullable().optional(),
  }),
});

export const ErrorNotificationSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  willRetry: z.boolean().optional(),
  error: TurnErrorSchema,
});

const TokenBreakdownSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number().optional(),
});

export const ThreadTokenUsageUpdatedNotificationSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  tokenUsage: z.object({
    total: TokenBreakdownSchema.optional(),
    last: TokenBreakdownSchema.optional(),
  }),
});

export const FileUpdateChangeSchema = z.object({
  path: z.string(),
  kind: z.unknown().optional(),
  diff: z.string().optional(),
});
export type CodexFileUpdateChange = z.infer<typeof FileUpdateChangeSchema>;

const McpToolCallResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
});

export const ThreadItemSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  text: z.string().optional(),
  summary: z.array(z.string()).optional(),
  content: z.array(z.unknown()).optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  changes: z.array(FileUpdateChangeSchema).optional(),
  server: z.string().optional(),
  namespace: z.string().nullable().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: McpToolCallResultSchema.nullable().optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
  contentItems: z.array(z.unknown()).nullable().optional(),
  success: z.boolean().nullable().optional(),
  prompt: z.string().nullable().optional(),
  query: z.string().optional(),
  path: z.string().optional(),
  review: z.string().optional(),
});
export type CodexThreadItem = z.infer<typeof ThreadItemSchema>;

export const ItemLifecycleNotificationSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  item: ThreadItemSchema,
});

export const ItemTextDeltaNotificationSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string().min(1),
  delta: z.string(),
  summaryIndex: z.number().int().optional(),
  contentIndex: z.number().int().optional(),
});

export const ReasoningSummaryPartAddedNotificationSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string().min(1),
  summaryIndex: z.number().int(),
});

export const CommandExecutionRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string().min(1),
  approvalId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
});

export const FileChangeRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string().min(1),
  reason: z.string().nullable().optional(),
  grantRoot: z.string().nullable().optional(),
  changes: z.array(FileUpdateChangeSchema).optional(),
  diff: z.string().nullable().optional(),
});

export type CodexApprovalDecision = "accept" | "decline";
